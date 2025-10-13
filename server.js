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
  console.log("User connected:", socket.id);

  socket.on("create_room", ({ roomCode, keyword, maxPlayers }) => {
    rooms[roomCode] = { host: socket.id, players: [], keyword };
    socket.join(roomCode);
    io.to(socket.id).emit("room_created", roomCode);
  });

  socket.on("join_room", ({ roomCode, playerName }) => {
    if (!rooms[roomCode]) return;
    rooms[roomCode].players.push({ id: socket.id, name: playerName });
    socket.join(roomCode);
    io.to(roomCode).emit("players_update", rooms[roomCode].players);
  });

  socket.on("start_game", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const players = room.players;
    const whiteHat = players[Math.floor(Math.random() * players.length)];

    players.forEach((p) => {
      io.to(p.id).emit("role_assigned", {
        role: p.id === whiteHat.id ? "whitehat" : "keyword",
        keyword: p.id === whiteHat.id ? null : room.keyword,
      });
    });

    io.to(roomCode).emit("game_started");
  });

  socket.on("reveal_role", ({ roomCode, playerId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    io.to(roomCode).emit("role_revealed", playerId);
  });

  socket.on("end_game", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    io.to(roomCode).emit("game_ended", room.players);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// tôi muốn hàm get để biết server đang chạy
app.get("/", (req, res) => {
  res.send("Server is running");
});

const PORT = process.env.PORT || 5008;
server.listen(PORT, () => console.log(`✅ Socket.IO running on port ${PORT}`));
