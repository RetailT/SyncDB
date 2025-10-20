const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
// const { authenticateToken } = require('./middleware/authenticateToken');
const { connectToDatabase } = require('./config/db');  // Import the connection function

const authController = require('./controllers/authController');

// Set up Express app
const app = express();
const port = 8010;
// const port = 5000;

const corsOptions = {
  origin: ['http://www.retailtarget.lk', 'http://retailtarget.lk', 'http://localhost:3000'], // Add both variants of the domain
  credentials: true,
  optionSuccessStatus: 200,
  methods: "GET,PUT,POST,DELETE"
};

// Middleware
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); 
app.use(bodyParser.json());

// Connect to the database before starting the server
connectToDatabase().then(() => {
   // Routes
   app.get("/", (req, res) => {res.send("Hello from Node.js");});

  // Start server
  app.listen(port,"0.0.0.0", () => {
    console.log(`Server running`);
  });
});
