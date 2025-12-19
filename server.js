const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { connectToDatabase } = require('./config/db');
require("dotenv").config();

// Import the sync function or cron starter
const { startSyncCron } = require('./controllers/authController'); // We'll create this

const app = express();
const port = process.env.NODE_PORT;

const corsOptions = {
  origin: ['http://www.retailtarget.lk', 'http://retailtarget.lk', 'http://localhost:3000'],
  credentials: true,
  optionSuccessStatus: 200,
  methods: "GET,PUT,POST,DELETE"
};

// Middleware
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); 
app.use(bodyParser.json());

// Connect to DB and start server + cron
connectToDatabase().then(() => {
  app.get("/", (req, res) => { res.send("Hello from Node.js"); });

  // Start the cron job after DB connection
  startSyncCron();  // <--- ADD THIS

  //Add Health Check Endpoint -- optional
  app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    time: getSriLankaTime(),
    cronRunning: isCronRunning
  });
});

  app.listen(parseInt(port.trim()), "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
  });
});