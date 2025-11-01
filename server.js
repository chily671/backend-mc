import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const rooms = {}; // { roomCode: { host, players, settings, started } }

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

  // 🏠 Tạo phòng
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
    io.emit("rooms_update", Object.keys(rooms)); // 🆕 broadcast danh sách phòng
    console.log(`🆕 Room ${roomCode} created by ${hostName}`);
  });

  // 👥 Vào phòng
  socket.on("join_room", ({ roomCode, playerName, userId }) => {
    const room = getRoom(roomCode);
    if (!room) {
      io.to(socket.id).emit("error_message", "Phòng không tồn tại!");
      return;
    }

    const existing = room.players.find((p) => p.id === userId);
    if (existing) {
      existing.socketId = socket.id;
    } else {
      room.players.push({ id: userId, socketId: socket.id, name: playerName, role: "player" });
    }

    socket.join(roomCode);
    updatePlayers(roomCode);
    console.log(`👤 ${playerName} joined room ${roomCode}`);
  });

  // 🆕 Rời phòng
  socket.on("leave_room", ({ roomCode, userId }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    room.players = room.players.filter((p) => p.id !== userId);
    socket.leave(roomCode);
    updatePlayers(roomCode);
    console.log(`🚪 User ${userId} left room ${roomCode}`);

    // Nếu host rời phòng thì xóa phòng luôn
    if (room.host === userId) {
      delete rooms[roomCode];
      io.emit("rooms_update", Object.keys(rooms)); // 🆕 cập nhật danh sách phòng
      console.log(`❌ Room ${roomCode} closed`);
    }
  });

  // 🆕 Gửi danh sách phòng hiện có
  socket.on("get_rooms", () => {
    socket.emit("rooms_update", Object.keys(rooms));
  });

  // ⚙️ Cài đặt phòng
  socket.on("update_settings", ({ roomCode, userId, newSettings }) => {
    const room = getRoom(roomCode);
    if (!room || room.host !== userId) return;

    room.settings = { ...room.settings, ...newSettings };
    io.to(roomCode).emit("settings_updated", room.settings);
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

    room.players = [room.players.find((p) => p.role === "host"), ...assigned];
    assigned.forEach((p) => io.to(p.socketId).emit("role_assigned", { role: p.role, keyword: p.keyword }));
    room.started = true;
    io.to(roomCode).emit("game_started");
  });

  // 🏁 Kết thúc
  socket.on("end_game", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    const reveal = room.players.filter((p) => p.role !== "host")
      .map((p) => ({ name: p.name, role: p.role, keyword: p.keyword }));

    io.to(roomCode).emit("game_ended", reveal);

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

  socket.on("disconnect", () => {
    console.log("🔴 Disconnected:", socket.id);
  });
});

app.get("/", (req, res) => res.send("✅ Socket server running!"));
const PORT = process.env.PORT || 5008;
server.listen(PORT, () => console.log(`🚀 Socket.IO running on port ${PORT}`));
