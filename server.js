import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const rooms = {}; // { roomCode: { host, players, settings, started } }

function getRoom(roomCode) {
  return rooms[roomCode];
}

function updatePlayers(roomCode) {
  const room = getRoom(roomCode);
  if (room) io.to(roomCode).emit("players_update", room.players);
}

io.on("connection", (socket) => {
  console.log("🟢", socket.id, "connected");

  socket.on("ping_check", () => socket.emit("pong"));
  // 🏠 Host tạo phòng
  socket.on("create_room", ({ roomCode, hostName, userId }) => {
    rooms[roomCode] = {
      host: userId,
      players: [
        { id: userId, socketId: socket.id, name: hostName, role: "host" },
      ],
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

    // 🔄 Gửi cập nhật danh sách phòng cho tất cả
    io.emit(
      "room_list_update",
      Object.entries(rooms).map(([code, data]) => ({
        code,
        host: data.players.find((p) => p.id === data.host)?.name || "Ẩn danh",
        playerCount: data.players.length,
        started: data.started,
      }))
    );
  });

  socket.on("join_room", ({ roomCode, playerName, userId }) => {
    const room = getRoom(roomCode);
    if (!room)
      return io.to(socket.id).emit("error_message", "Phòng không tồn tại!");

    const existing = room.players.find((p) => p.id === userId);
    if (existing) existing.socketId = socket.id;
    else
      room.players.push({
        id: userId,
        socketId: socket.id,
        name: playerName,
        role: "player",
      });

    socket.join(roomCode);
    updatePlayers(roomCode);
  });

  // 🚪 Người chơi rời phòng
  socket.on("leave_room", ({ roomCode, userId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const idx = room.players.findIndex((p) => p.id === userId);
    if (idx !== -1) {
      const player = room.players[idx];
      console.log(`🚪 ${player.name} left room ${roomCode}`);
      room.players.splice(idx, 1);
      socket.leave(roomCode);

      // Nếu host rời → xoá cả phòng
      if (userId === room.host) {
        delete rooms[roomCode];
        console.log(`❌ Room ${roomCode} removed (host left)`);
        io.emit(
          "room_list_update",
          Object.entries(rooms).map(([code, data]) => ({
            code,
            host:
              data.players.find((p) => p.id === data.host)?.name || "Ẩn danh",
            playerCount: data.players.length,
            started: data.started,
          }))
        );
      } else {
        updatePlayers(roomCode);
      }
    }
  });

  socket.on("update_settings", ({ roomCode, userId, newSettings }) => {
    const room = getRoom(roomCode);
    if (!room || room.host !== userId) return;
    room.settings = { ...room.settings, ...newSettings };
    io.to(roomCode).emit("settings_updated", room.settings);
  });

  // 🔹 Gửi danh sách phòng hiện tại khi client yêu cầu
  socket.on("get_rooms", () => {
    const list = Object.entries(rooms).map(([code, data]) => ({
      code,
      host: data.players.find((p) => p.id === data.host)?.name || "Ẩn danh",
      playerCount: data.players.length,
      started: data.started,
    }));
    io.to(socket.id).emit("room_list", list);
  });

  socket.on("start_game", ({ roomCode, userId }) => {
    const room = getRoom(roomCode);
    if (!room || room.started || room.host !== userId) return;

    const { villagers, spies, whiteHats, keywords } = room.settings;
    const players = room.players.filter((p) => p.role !== "host");

    const shuffled = [...players].sort(() => Math.random() - 0.5);
    const assigned = [
      ...shuffled
        .slice(0, villagers)
        .map((p) => ({ ...p, role: "villager", keyword: keywords.villager })),
      ...shuffled
        .slice(villagers, villagers + spies)
        .map((p) => ({ ...p, role: "spy", keyword: keywords.spy })),
      ...shuffled
        .slice(villagers + spies, villagers + spies + whiteHats)
        .map((p) => ({ ...p, role: "whiteHat", keyword: keywords.whiteHat })),
    ];

    room.players = [room.players.find((p) => p.role === "host"), ...assigned];
    assigned.forEach((p) =>
      io
        .to(p.socketId)
        .emit("role_assigned", { role: p.role, keyword: p.keyword })
    );
    room.started = true;
    io.to(roomCode).emit("game_started");
  });

  socket.on("end_game", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    const reveal = room.players
      .filter((p) => p.role !== "host")
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
    for (const [roomCode, room] of Object.entries(rooms)) {
      const player = room.players.find((p) => p.socketId === socket.id);
      if (player) {
        player.socketId = null;
        updatePlayers(roomCode);
      }
    }
  });

  socket.on("reconnect_room", ({ roomCode, userId }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    const player = room.players.find((p) => p.id === userId);
    if (player) {
      player.socketId = socket.id;
      socket.join(roomCode);
      updatePlayers(roomCode);
      io.to(socket.id).emit("reconnected_success");
    }
  });
});

app.get("/", (_, res) => res.send("✅ Server đang chạy"));

const PORT = process.env.PORT || 5008;
server.listen(PORT, () => console.log(`🚀 Server chạy tại cổng ${PORT}`));
