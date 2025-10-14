import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const rooms = {};

io.on("connection", (socket) => {
  console.log("🟢 User connected:", socket.id);

  // 🏠 Host tạo phòng
  socket.on("create_room", ({ roomCode, hostName }) => {
    rooms[roomCode] = {
      host: socket.id,
      players: [{ id: socket.id, name: hostName, role: "host" }],
      settings: {
        villagers: 3,
        spies: 1,
        whiteHats: 0,
        keywords: { villager: "", spy: "", whiteHat: "" },
      },
      started: false,
    };
    socket.join(roomCode);
    io.to(socket.id).emit("room_created", roomCode);
    console.log(`🆕 Room ${roomCode} created by ${hostName}`);
  });

  // 👥 Người chơi khác tham gia phòng
  socket.on("join_room", ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.players.push({ id: socket.id, name: playerName, role: "player" });
    socket.join(roomCode);
    io.to(roomCode).emit("players_update", room.players);
    console.log(`👤 ${playerName} joined room ${roomCode}`);
  });

  // ⚙️ Host cập nhật cài đặt
  socket.on("update_settings", ({ roomCode, newSettings }) => {
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id) return;
    room.settings = { ...room.settings, ...newSettings };
    io.to(roomCode).emit("settings_updated", room.settings);
    console.log(`⚙️ Room ${roomCode} settings updated`);
  });

  // ▶️ Host bắt đầu trò chơi
  socket.on("start_game", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.started) return;

    const { villagers, spies, whiteHats, keywords } = room.settings;
    const players = [...room.players.filter((p) => p.role !== "host")];

    // Kiểm tra số lượng
    const totalNeeded = villagers + spies + whiteHats;
    if (players.length < totalNeeded) {
      io.to(room.host).emit("error_message", "Không đủ người chơi để bắt đầu!");
      return;
    }

    // Xáo trộn danh sách
    const shuffled = players.sort(() => Math.random() - 0.5);

    // Chia vai
    const assignedRoles = [];
    assignedRoles.push(
      ...shuffled.slice(0, villagers).map((p) => ({
        ...p,
        role: "villager",
        keyword: keywords.villager,
      }))
    );
    assignedRoles.push(
      ...shuffled.slice(villagers, villagers + spies).map((p) => ({
        ...p,
        role: "spy",
        keyword: keywords.spy,
      }))
    );
    assignedRoles.push(
      ...shuffled
        .slice(villagers + spies, villagers + spies + whiteHats)
        .map((p) => ({
          ...p,
          role: "whiteHat",
          keyword: keywords.whiteHat || null,
        }))
    );

    // Cập nhật lại room.players
    room.players = [
      room.players.find((p) => p.role === "host"), // giữ host
      ...assignedRoles,
    ];

    // Gửi vai + từ khóa riêng cho từng người
    assignedRoles.forEach((player) => {
      io.to(player.id).emit("role_assigned", {
        role: player.role,
        keyword: player.keyword,
      });
    });

    room.started = true;
    io.to(roomCode).emit("game_started");
    console.log(`🎮 Game started in room ${roomCode}`);
  });

  // 🏁 Kết thúc game
  socket.on("end_game", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    // ✅ Lấy role & keyword thật đã được lưu
    const revealData = room.players
      .filter((p) => p.role !== "host")
      .map((p) => ({
        name: p.name,
        role: p.role,
        keyword: p.keyword,
      }));

    io.to(roomCode).emit("game_ended", revealData);
    console.log(`🏁 Game ended in room ${roomCode}`);

    // Sau vài giây reset lại phòng
    setTimeout(() => {
      room.started = false;
      room.players.forEach((p) => {
        if (p.role !== "host") {
          p.role = "player";
          p.keyword = null;
        }
      });
      io.to(roomCode).emit("players_update", room.players);
    }, 5000);
  });

  // ❌ Ngắt kết nối
  socket.on("disconnect", () => {
    console.log("🔴 User disconnected:", socket.id);

    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx !== -1) {
        const player = room.players[idx];
        room.players.splice(idx, 1);
        io.to(roomCode).emit("players_update", room.players);
        console.log(`❎ ${player.name} left room ${roomCode}`);
        break;
      }
    }
  });
});

app.get("/", (req, res) => {
  res.send("✅ Socket server is running fine!");
});

const PORT = process.env.PORT || 5008;
server.listen(PORT, () =>
  console.log(`🚀 Socket.IO running on port ${PORT}`)
);
