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
  console.log("🟢 Connected:", socket.id);

  // 🏠 Tạo phòng
  socket.on("create_room", ({ roomCode, hostName, userId }) => {
    if (!roomCode || !hostName) return;

    rooms[roomCode] = {
      host: socket.id,
      players: [{ id: socket.id, userId, name: hostName, role: "host" }],
      settings: {
        villagers: 3,
        spies: 1,
        whiteHats: 1,
        keywords: { villager: "", spy: "", whiteHat: "" },
      },
      started: false,
    };

    socket.join(roomCode);
    io.to(socket.id).emit("room_created", roomCode);
    io.to(roomCode).emit("players_update", rooms[roomCode].players);

    console.log(`🆕 Room ${roomCode} created by ${hostName}`);
  });

  // 👥 Vào phòng
  socket.on("join_room", ({ roomCode, playerName, userId }) => {
    const room = rooms[roomCode];
    if (!room) {
      io.to(socket.id).emit("error_message", "Không tìm thấy phòng!");
      return;
    }

    const exists = room.players.find((p) => p.userId === userId);
    if (exists) {
      io.to(socket.id).emit("error_message", "Tên này đã có trong phòng!");
      return;
    }

    const newPlayer = { id: socket.id, userId, name: playerName, role: "player" };
    room.players.push(newPlayer);

    socket.join(roomCode);
    io.to(roomCode).emit("players_update", room.players);
    console.log(`👤 ${playerName} joined room ${roomCode}`);
  });

  // 🧩 Reconnect người chơi cũ
  socket.on("reconnect_room", ({ roomCode, userId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players.find((p) => p.userId === userId);
    if (player) {
      player.id = socket.id; // Cập nhật ID mới
      socket.join(roomCode);
      io.to(socket.id).emit("reconnected_success");
      io.to(roomCode).emit("players_update", room.players);
      console.log(`🔁 ${player.name} reconnected to ${roomCode}`);
    }
  });

  // ⚙️ Cập nhật cài đặt (chỉ host)
  socket.on("update_settings", ({ roomCode, userId, newSettings }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.host !== socket.id) return;

    room.settings = { ...room.settings, ...newSettings };
    io.to(roomCode).emit("settings_updated", room.settings);
  });

  // ▶️ Bắt đầu trò chơi
  socket.on("start_game", ({ roomCode, userId }) => {
    const room = rooms[roomCode];
    if (!room || room.started) return;

    const { villagers, spies, whiteHats, keywords } = room.settings;
    const players = room.players.filter((p) => p.role !== "host");
    const totalNeeded = villagers + spies + whiteHats;

    if (players.length < totalNeeded) {
      io.to(room.host).emit("error_message", "Không đủ người chơi!");
      return;
    }

    // Xáo trộn & chia vai
    const shuffled = [...players].sort(() => Math.random() - 0.5);
    const assigned = [];

    assigned.push(
      ...shuffled.slice(0, villagers).map((p) => ({
        ...p,
        role: "villager",
        keyword: keywords.villager,
      }))
    );
    assigned.push(
      ...shuffled.slice(villagers, villagers + spies).map((p) => ({
        ...p,
        role: "spy",
        keyword: keywords.spy,
      }))
    );
    assigned.push(
      ...shuffled
        .slice(villagers + spies, villagers + spies + whiteHats)
        .map((p) => ({
          ...p,
          role: "whiteHat",
          keyword: keywords.whiteHat,
        }))
    );

    // Cập nhật lại danh sách
    room.players = [room.players.find((p) => p.role === "host"), ...assigned];

    // Gửi vai riêng
    assigned.forEach((p) => {
      io.to(p.id).emit("role_assigned", {
        role: p.role,
        keyword: p.keyword,
      });
    });

    room.started = true;
    io.to(roomCode).emit("game_started");
    console.log(`🎮 Game started in ${roomCode}`);
  });

  // 🏁 Kết thúc
  socket.on("end_game", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const result = room.players
      .filter((p) => p.role !== "host")
      .map((p) => ({ name: p.name, role: p.role, keyword: p.keyword }));

    io.to(roomCode).emit("game_ended", result);
    console.log(`🏁 Game ended in ${roomCode}`);

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
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const index = room.players.findIndex((p) => p.id === socket.id);
      if (index !== -1) {
        const left = room.players[index];
        console.log(`❎ ${left.name} left ${roomCode}`);
        room.players.splice(index, 1);
        io.to(roomCode).emit("players_update", room.players);
        break;
      }
    }
  });
});

app.get("/", (req, res) => res.send("✅ Socket server running"));
const PORT = process.env.PORT || 5008;
server.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
