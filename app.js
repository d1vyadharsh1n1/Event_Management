const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5000;
const SECRET_KEY = "your_secret_key"; // Change this to a secure key
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "http://localhost:5000", methods: ["GET", "POST"] },
});
app.use(cors());
app.use(bodyParser.json());
app.use(express.json());
app.use(express.static("public")); // To serve static files

// Routes
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "register.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/organiser", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "organiser.html"));
});

// MySQL Database Connection
const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "divya@250705",
  database: "events",
});

db.connect((err) => {
  if (err) {
    console.error("Database connection failed:", err);
    return;
  }
  console.log("Connected to MySQL");
});

// Create Users Table
db.query(
  `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100),
        email VARCHAR(100) UNIQUE,
        password VARCHAR(255),
        role ENUM('student', 'organiser', 'faculty') NOT NULL
    )`,
  (err) => {
    if (err) console.error("Error creating table:", err);
  }
);

// Register Route
app.post("/auth/register", async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role) {
    return res.status(400).json({ message: "All fields are required" });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  db.query(
    "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)",
    [name, email, hashedPassword, role],
    (err, result) => {
      if (err) {
        console.error("Error inserting user:", err);
        return res.status(500).json({ error: "Registration failed." });
      }
      res.json({ message: "User registered successfully!" });
    }
  );
});

// Login Route
app.post("/auth/login", (req, res) => {
  const { email, password } = req.body;

  db.query("SELECT * FROM users WHERE email = ?", [email], (err, result) => {
    if (err) {
      return res.status(500).json({ error: "Database error" });
    }

    if (result.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result[0];

    bcrypt.compare(password, user.password, (err, isMatch) => {
      if (err || !isMatch) {
        return res.status(400).json({ error: "Invalid credentials" });
      }

      // Ensure only one response is sent
      res.json({
        message: "Login successful",
        token: "dummy-jwt-token",
        role: user.role,
      });
    });
  });
});

app.post("/organiser/add-event", (req, res) => {
  const { name, description, date, expectedParticipants } = req.body;

  if (!name || !description || !date || !expectedParticipants) {
    return res.status(400).json({ error: "All fields are required." });
  }

  // Check for existing events on the same date
  db.query("SELECT * FROM events WHERE date = ?", [date], (err, results) => {
    if (err) {
      console.error("Error checking existing events:", err);
      return res.status(500).json({ error: "Database error" });
    }

    if (results.length > 0) {
      // If an event exists on the same date, notify the organiser
      const existingEvent = results[0]; // Get the first conflicting event
      return res.status(409).json({
        warning: `Event "${existingEvent.name}" (Expected: ${existingEvent.expectedParticipants} participants) is already scheduled for this date.`,
        conflict: true,
      });
    }
    // Assign Hall Based on Expected Participants
    let hall = "";
    if (expectedParticipants >= 1000) {
      hall = "Main Auditorium";
    } else if (expectedParticipants >= 500) {
      hall = "Mini Auditorium";
    } else if (expectedParticipants > 120) {
      hall = Math.random() < 0.5 ? "Seminar Hall 1" : "Seminar Hall 2";
    } else {
      let lectureHall = Math.floor(Math.random() * 3) + 1; // Randomly pick 1, 2, or 3
      hall = `Lecture Hall ${lectureHall}`;
    }
    // If no conflicts, proceed with event creation
    db.query(
      "INSERT INTO events (name, description, date, expectedParticipants, hall) VALUES (?, ?, ?, ?, ?)",
      [name, description, date, expectedParticipants, hall],
      (err, result) => {
        if (err) {
          console.error("Error inserting event:", err);
          return res.status(500).json({ error: "Failed to add event." });
        }
        res.status(200).json({
          message: "Event added successfully! Hall Assigned: ${hall}",
        });
      }
    );
  });
});

// Fetch events
app.get("/events", (req, res) => {
  db.query("SELECT * FROM events", (err, results) => {
    if (err) return res.status(500).json({ message: "Failed to fetch events" });
    res.json(results);
  });
});

// In-memory store for votes (Resets when server restarts)
let eventVotes = {};

io.on("connection", (socket) => {
  console.log("A user connected");

  // Send the current vote count to the new user
  socket.emit("updateVotes", eventVotes);

  socket.on("vote", ({ eventId, type }) => {
    if (!eventVotes[eventId])
      eventVotes[eventId] = { interested: 0, not_interested: 0 };

    // Update votes based on type
    if (type === "interested") eventVotes[eventId].interested++;
    if (type === "not_interested") eventVotes[eventId].not_interested++;

    // Broadcast updated vote counts to all users
    io.emit("updateVotes", eventVotes);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

// Vote event
app.post("/events/vote", (req, res) => {
  const { eventId, type } = req.body;

  if (!eventVotes[eventId])
    eventVotes[eventId] = { interested: 0, not_interested: 0 };

  if (type === "interested") eventVotes[eventId].interested++;
  if (type === "not_interested") eventVotes[eventId].not_interested++;

  io.emit("updateVotes", eventVotes); // Broadcast to all connected clients

  res.json({ message: "Vote recorded successfully" });
});

app.put("/organiser/edit-event/:id", (req, res) => {
  const { id } = req.params;
  const { name, description, date, expectedParticipants } = req.body;

  db.query(
    "UPDATE events SET name=?, description=?, date=?, expectedParticipants=? WHERE id=?",
    [name, description, date, expectedParticipants, id],
    (err, result) => {
      if (err) return res.status(500).json({ error: "Error updating event" });
      res.json({ message: "Event updated successfully!" });
    }
  );
});
app.delete("/organiser/delete-event/:id", (req, res) => {
  const { id } = req.params;

  db.query("DELETE FROM events WHERE id=?", [id], (err, result) => {
    if (err) return res.status(500).json({ error: "Error deleting event" });
    res.json({ message: "Event deleted successfully!" });
  });
});

// Start Server
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
