import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const rooms = {}; // { roomCode: { host, players, settings, started } }

// 🧠 Hàm tiện ích
function getRoom(roomCode) {
  return rooms[roomCode];
}

function updatePlayers(roomCode) {
  const room = getRoom(roomCode);
  if (room) io.to(roomCode).emit("players_update", room.players);
}

// ⚡ Socket.IO logic
io.on("connection", (socket) => {
  console.log("🟢 User connected:", socket.id);

  // 🏠 Host tạo phòng
  socket.on("create_room", ({ roomCode, hostName, userId }) => {
    rooms[roomCode] = {
      host: userId,
      players: [{ id: userId, socketId: socket.id, name: hostName, role: "host" }],
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

  // 👥 Người chơi khác tham gia
  socket.on("join_room", ({ roomCode, playerName, userId }) => {
    const room = getRoom(roomCode);
    if (!room) {
      io.to(socket.id).emit("error_message", "Phòng không tồn tại!");
      return;
    }

    // Kiểm tra nếu đã tồn tại userId
    const existing = room.players.find((p) => p.id === userId);
    if (existing) {
      existing.socketId = socket.id; // Cập nhật lại socketId mới
    } else {
      room.players.push({ id: userId, socketId: socket.id, name: playerName, role: "player" });
    }

    socket.join(roomCode);
    updatePlayers(roomCode);
    console.log(`👤 ${playerName} joined room ${roomCode}`);
  });

  // ⚙️ Host cập nhật cài đặt
  socket.on("update_settings", ({ roomCode, userId, newSettings }) => {
    const room = getRoom(roomCode);
    if (!room || room.host !== userId) return;

    room.settings = { ...room.settings, ...newSettings };
    io.to(roomCode).emit("settings_updated", room.settings);
    console.log(`⚙️ Room ${roomCode} settings updated`);
  });

  // ▶️ Bắt đầu trò chơi
  socket.on("start_game", ({ roomCode, userId }) => {
    const room = getRoom(roomCode);
    if (!room || room.started || room.host !== userId) return;

    const { villagers, spies, whiteHats, keywords } = room.settings;
    const players = room.players.filter((p) => p.role !== "host");

    const totalNeeded = villagers + spies + whiteHats;
    if (players.length < totalNeeded) {
      io.to(room.host).emit("error_message", "Không đủ người chơi để bắt đầu!");
      return;
    }

    const shuffled = [...players].sort(() => Math.random() - 0.5);

    const assigned = [
      ...shuffled.slice(0, villagers).map((p) => ({ ...p, role: "villager", keyword: keywords.villager })),
      ...shuffled.slice(villagers, villagers + spies).map((p) => ({ ...p, role: "spy", keyword: keywords.spy })),
      ...shuffled
        .slice(villagers + spies, villagers + spies + whiteHats)
        .map((p) => ({ ...p, role: "whiteHat", keyword: keywords.whiteHat || null })),
    ];

    room.players = [
      room.players.find((p) => p.role === "host"),
      ...assigned,
    ];

    // Gửi riêng role cho từng người
    assigned.forEach((p) => {
      io.to(p.socketId).emit("role_assigned", {
        role: p.role,
        keyword: p.keyword,
      });
    });

    room.started = true;
    io.to(roomCode).emit("game_started");
    console.log(`🎮 Game started in room ${roomCode}`);
  });

  // 🏁 Kết thúc game
  socket.on("end_game", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    const reveal = room.players
      .filter((p) => p.role !== "host")
      .map((p) => ({ name: p.name, role: p.role, keyword: p.keyword }));

    io.to(roomCode).emit("game_ended", reveal);
    console.log(`🏁 Game ended in room ${roomCode}`);

    // Reset sau 5s
    setTimeout(() => {
      room.started = false;
      room.players.forEach((p) => {
        if (p.role !== "host") {
          p.role = "player";
          p.keyword = null;
        }
      });
      updatePlayers(roomCode);
    }, 5000);
  });

  // ❌ Ngắt kết nối
  socket.on("disconnect", () => {
    console.log("🔴 Disconnected:", socket.id);

    for (const [roomCode, room] of Object.entries(rooms)) {
      const idx = room.players.findIndex((p) => p.socketId === socket.id);
      if (idx !== -1) {
        const player = room.players[idx];
        console.log(`❎ ${player.name} temporarily disconnected from ${roomCode}`);

        // Giữ player lại — chỉ đánh dấu tạm mất kết nối
        room.players[idx].socketId = null;

        updatePlayers(roomCode);
        break;
      }
    }
  });

  // 🔁 Khi người chơi quay lại (reconnect)
  socket.on("reconnect_room", ({ roomCode, userId }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    const player = room.players.find((p) => p.id === userId);
    if (player) {
      player.socketId = socket.id;
      socket.join(roomCode);
      updatePlayers(roomCode);
      io.to(socket.id).emit("reconnected_success");
      console.log(`🔁 ${player.name} reconnected to room ${roomCode}`);
    }
  });
});

app.get("/", (req, res) => res.send("✅ Socket server running!"));

const PORT = process.env.PORT || 5008;
server.listen(PORT, () => console.log(`🚀 Socket.IO running on port ${PORT}`));
