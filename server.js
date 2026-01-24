const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const mongoose = require("mongoose");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(
  cors({
    origin: "http://localhost:5173",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

// ────────────────────────────────────────────────
// MongoDB Connection
// ────────────────────────────────────────────────
mongoose
  .connect(
    "mongodb+srv://projectmail2030010_db_user:<db_password>@ai-drive-db.u2usteh.mongodb.net/?appName=ai-drive-db",
    {serverSelectionTimeoutMS: 5000,   // fail faster on bad config
  socketTimeoutMS: 45000,
    },
  )
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// ────────────────────────────────────────────────
// Models (you can move these to a /models folder later)
// ────────────────────────────────────────────────

const locationSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  socketId: String,
  village: String,
  town: String,
  state: String,
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now },
});
const Location = mongoose.model("Location", locationSchema);

const reportSchema = new mongoose.Schema({
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: "Location" },
  socketId: String,
  reporterName: String,
  householdCount: Number,
  urgency: String,
  helpTypes: [String], // native array — huge improvement
  message: String,
  additionalInfo: String,
  lat: Number,
  lng: Number,
  createdAt: { type: Date, default: Date.now },
});
const Report = mongoose.model("Report", reportSchema);

const resourceSchema = new mongoose.Schema({
  name: String,
  quantity: Number,
  category: String,
  createdAt: { type: Date, default: Date.now },
});
const Resource = mongoose.model("Resource", resourceSchema);

const operationSchema = new mongoose.Schema({
  name: String,
  status: String,
  lead: String,
  location: String,
  assignedTeam: String,
  createdAt: { type: Date, default: Date.now },
});
const Operation = mongoose.model("Operation", operationSchema);

const rescueTeamSchema = new mongoose.Schema({
  name: String,
  status: String,
  location: String,
  contact_person: String,
  contact_number: String,
  createdAt: { type: Date, default: Date.now },
});
const RescueTeam = mongoose.model("RescueTeam", rescueTeamSchema);

const shelterSchema = new mongoose.Schema({
  name: String,
  occupancy: { type: Number, default: 0 },
  capacity: { type: Number, default: 100 },
  status: { type: String, default: "Moderate" },
  latitude: Number,
  longitude: Number,
  updatedAt: { type: Date, default: Date.now },
});
const Shelter = mongoose.model("Shelter", shelterSchema);

const adminSchema = new mongoose.Schema({
  username: String,
  password: String, // ← in production: hash this with bcrypt!
});
const Admin = mongoose.model("Admin", adminSchema);

// ────────────────────────────────────────────────
// In-memory user locations (for Socket.IO)
// ────────────────────────────────────────────────
let users = {};

// ────────────────────────────────────────────────
// Socket.IO Logic
// ────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("sendLocation", async (data) => {
    const { lat, lng, village, town, state, userId } = data;

    if (!userId || !village || !town || !state) {
      console.warn("Incomplete location data");
      return;
    }

    try {
      let location = await Location.findOne({ userId });

      if (location) {
        // update
        Object.assign(location, {
          lat,
          lng,
          village,
          town,
          state,
          socketId: socket.id,
        });
        await location.save();
      } else {
        // create
        location = await Location.create({
          userId,
          socketId: socket.id,
          village,
          town,
          state,
          lat,
          lng,
        });
      }

      users[socket.id] = {
        lat,
        lng,
        village,
        town,
        state,
        locationId: location._id.toString(),
      };

      io.emit("updateLocations", users);
    } catch (err) {
      console.error("Location error:", err);
    }
  });

  socket.on("getReports", async () => {
    try {
      const reports = await Report.find()
        .populate("locationId", "village town state")
        .sort({ createdAt: -1 })
        .lean();

      socket.emit("updateReports", reports);
    } catch (err) {
      console.error("getReports error:", err);
    }
  });

  socket.on("sendReport", async (report) => {
    const {
      reporterName,
      householdCount,
      urgency,
      helpTypes = [],
      message,
      additionalInfo,
      lat,
      lng,
    } = report;

    const locationId = users[socket.id]?.locationId || null;

    try {
      await Report.create({
        locationId: locationId ? new mongoose.Types.ObjectId(locationId) : null,
        socketId: socket.id,
        reporterName,
        householdCount,
        urgency,
        helpTypes, // ← array directly
        message,
        additionalInfo,
        lat,
        lng,
      });

      const updated = await Report.find()
        .populate("locationId", "village town state")
        .sort({ createdAt: -1 })
        .lean();

      io.emit("updateReports", updated);
    } catch (err) {
      console.error("save report error:", err);
    }
  });

  socket.on("disconnect", () => {
    delete users[socket.id];
    io.emit("updateLocations", users);
    console.log("User disconnected:", socket.id);
  });
});

// ────────────────────────────────────────────────
// REST Routes
// ────────────────────────────────────────────────

app.get("/api/reports", async (req, res) => {
  try {
    const reports = await Report.find()
      .populate("locationId", "village town state")
      .sort({ createdAt: -1 })
      .lean();

    // rename fields to match your frontend expectation
    const formatted = reports.map((r) => ({
      id: r._id,
      author: r.reporterName,
      category: r.urgency,
      content: r.message,
      householdCount: r.householdCount,
      helpTypes: r.helpTypes || [],
      additionalInfo: r.additionalInfo,
      date: r.createdAt,
      lat: r.lat,
      lng: r.lng,
      village: r.locationId?.village,
      town: r.locationId?.town,
      state: r.locationId?.state,
    }));

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/d", (req, res) => res.send("d"));

// Resources
app.post("/api/resources", async (req, res) => {
  try {
    const resource = await Resource.create(req.body);
    res.status(201).json(resource);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/resources", async (req, res) => {
  try {
    const resources = await Resource.find().sort({ createdAt: -1 });
    res.json(resources);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Operations
app.post("/api/operations", async (req, res) => {
  const { name, status, lead, location, assignedTeam } = req.body;

  try {
    const operation = await Operation.create({
      name,
      status,
      lead,
      location,
      assignedTeam,
    });

    // Update team status
    await RescueTeam.updateOne({ name: assignedTeam }, { status: "Deployed" });

    res.status(201).json(operation);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.put("/api/operations/:id/status", async (req, res) => {
  const { status } = req.body;
  if (!["Active", "Standby", "Completed", "Aborted"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  try {
    const op = await Operation.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true },
    );
    if (!op) return res.status(404).json({ error: "Operation not found" });
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/operations", async (req, res) => {
  try {
    const ops = await Operation.find().sort({ createdAt: -1 });
    res.json(ops);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Rescue Teams
app.post("/api/rescue-teams", async (req, res) => {
  try {
    const team = await RescueTeam.create(req.body);
    res.status(201).json(team);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/rescue-teams", async (req, res) => {
  try {
    const teams = await RescueTeam.find().sort({ createdAt: -1 });
    res.json(teams);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.put("/api/rescue-teams/status", async (req, res) => {
  const { name, status } = req.body;
  try {
    await RescueTeam.updateOne({ name }, { status });
    res.json({ message: "Team status updated" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.put("/api/rescue-teams/status-by-operation", async (req, res) => {
  const { operationId, status } = req.body;
  try {
    const op = await Operation.findById(operationId);
    if (!op) return res.status(404).json({ error: "Operation not found" });

    await RescueTeam.updateOne({ name: op.assignedTeam }, { status });
    res.json({ message: "Rescue team status updated" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/rescue-teams/:id", async (req, res) => {
  try {
    const result = await RescueTeam.findByIdAndDelete(req.params.id);
    if (!result) return res.status(404).json({ error: "Team not found" });
    res.json({ message: "Team deleted" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Shelters
app.post("/api/shelters", async (req, res) => {
  let {
    name,
    occupancy = 0,
    capacity = 100,
    status = "Moderate",
    latitude,
    longitude,
  } = req.body;

  // Basic validation (you can expand this)
  if (!name?.trim())
    return res.status(400).json({ error: "Shelter name required" });
  name = name.trim();

  latitude = Number(latitude);
  longitude = Number(longitude);
  if (isNaN(latitude) || isNaN(longitude))
    return res.status(400).json({ error: "Invalid coordinates" });

  occupancy = Number(occupancy) || 0;
  capacity = Number(capacity) || 100;

  const validStatuses = ["Moderate", "High", "Critical"];
  if (!validStatuses.includes(status)) status = "Moderate";

  try {
    const shelter = await Shelter.create({
      name,
      occupancy,
      capacity,
      status,
      latitude,
      longitude,
      updatedAt: new Date(),
    });
    res.status(201).json({
      message: "Evacuation center added successfully!",
      shelter,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to add shelter" });
  }
});

app.get("/api/shelters", async (req, res) => {
  try {
    const shelters = await Shelter.find().sort({ updatedAt: -1 });
    res.json(shelters);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.put("/api/shelters/:id", async (req, res) => {
  try {
    const shelter = await Shelter.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!shelter) return res.status(404).json({ error: "Shelter not found" });
    res.json({ message: "Shelter updated", shelter });
  } catch (err) {
    res.status(500).json({ error: "Update failed" });
  }
});

app.delete("/api/shelters/:id", async (req, res) => {
  try {
    const result = await Shelter.findByIdAndDelete(req.params.id);
    if (!result) return res.status(404).json({ error: "Shelter not found" });
    res.json({ message: "Shelter deleted" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Summary endpoints
app.get("/api/operation-summary", async (req, res) => {
  try {
    const summary = await Operation.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $project: { status: "$_id", count: 1, _id: 0 } },
    ]);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/daily-reports", async (req, res) => {
  try {
    const daily = await Report.aggregate([
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { date: "$_id", count: 1, _id: 0 } },
    ]);
    res.json(daily);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Admin (warning: plain passwords are insecure!)
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")?.[1];
  if (!token) return res.status(403).json({ error: "No token" });

  try {
    req.admin = jwt.verify(
      token,
      "9a1c3adcd3bc0ea35b25423c86edccecd066298040fde78eaf8908946fc09a82",
    );
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};

app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const admin = await Admin.findOne({ username, password });
    if (!admin) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: admin._id, username: admin.username },
      "9a1c3adcd3bc0ea35b25423c86edccecd066298040fde78eaf8908946fc09a82",
      { expiresIn: "1h" },
    );
    res.json({ message: "Login successful", token });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/admin/dashboard", verifyToken, (req, res) => {
  res.json({ message: `Welcome, ${req.admin.username}` });
});

// AI query (unchanged)
app.post("/query", async (req, res) => {
  const { prompt } = req.body;

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  async function callOpenAI(prompt, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await axios.post(
          "https://api.openai.com/v1/chat/completions",
          {
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
          },
          {
            headers: {
              Authorization: "Bearer sk-proj-...", // ← your key
            },
          },
        );
        return response.data.choices[0].message.content;
      } catch (err) {
        if (err.response?.status === 429 && i < retries - 1) {
          await delay(1000 * Math.pow(2, i));
        } else {
          throw err;
        }
      }
    }
    throw new Error("Max retries reached");
  }

  try {
    const reply = await callOpenAI(prompt);
    res.json({ reply });
  } catch (err) {
    console.error("OpenAI error:", err);
    res.status(500).json({ error: "AI query failed" });
  }
});
// Add near the top: const axios = require('axios');  (you already have it)

// Free reverse geocoding option using BigDataCloud (no key needed for client-side / low volume)
app.get("/api/reverse-geocode", async (req, res) => {
  const { lat, lon } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: "lat and lon are required" });
  }

  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);

  if (isNaN(latNum) || isNaN(lonNum)) {
    return res.status(400).json({ error: "Invalid latitude or longitude" });
  }

  try {
    // Option 1: BigDataCloud free reverse geocode to city (good for PH, returns locality/admin areas)
    const response = await axios.get(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latNum}&longitude=${lonNum}&localityLanguage=en`,
    );

    const data = response.data;

    // Format similar to what your app seems to expect
    const result = {
      village: data.locality || data.city || "Unknown",
      town: data.city || data.administrative || "Unknown",
      state: data.principalSubdivision || data.countryName || "Unknown",
      fullAddress: data.locality
        ? `${data.locality}, ${data.city}, ${data.principalSubdivision}`
        : "Address not found",
      raw: data, // for debugging
    };

    res.json(result);
  } catch (error) {
    console.error("Reverse geocode error:", error.message);
    res.status(500).json({ error: "Failed to reverse geocode" });
  }
});
// Start server
server.listen(5000, () => {
  console.log(
    "Server running on port http://localhost:5000 (Socket.IO + HTTP)",
  );
});
