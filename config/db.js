const mssql = require('mssql');
require('dotenv').config();

// MSSQL database configuration
const dbConfig = {
  user: process.env.DB_USER,      // Database username
  password: process.env.DB_PASSWORD,  // Database password
  server: process.env.DB_SERVER,        // Database server address
  database: process.env.DB_DATABASE1,  // Database name
  options: {
    encrypt: false,            // Disable encryption
    trustServerCertificate: true // Trust server certificate (useful for local databases)
  },
  port: 1443                   // Default MSSQL port (1433)
};

// Connect to MSSQL server asynchronously
const connectToDatabase = async () => {
  try {
    await mssql.connect(dbConfig);
    console.log('Connected to the MSSQL database');
  } catch (err) {
    console.error('Database connection failed:', err);
    process.exit(1);
  }
};

// Export connection function for use in other files
module.exports = { connectToDatabase, mssql };
