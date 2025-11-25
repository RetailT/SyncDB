const mssql = require('mssql');
require('dotenv').config();

const cachedPools = {};  // key: ip:port

const connectToUserDatabase = async (ip, port) => {
  const key = `${ip}:${port}`;

  if (cachedPools[key] && cachedPools[key].connected) {
    try {
      await cachedPools[key].request().query('SELECT 1');
      return cachedPools[key];
    } catch (err) {
      console.warn(`User pool stale for ${key}, reconnecting...`);
      await cachedPools[key].close();
      delete cachedPools[key];
    }
  }

  const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: ip.trim(),
    database: process.env.DB_DATABASE2,  // RT_WEB
    port: parseInt(port.trim(), 10) || 1433,
    options: { encrypt: false, trustServerCertificate: true },
    requestTimeout: 15000,
  };

  const pool = await new mssql.ConnectionPool(config).connect();
  cachedPools[key] = pool;
  console.log(`Connected to USER DB: ${ip}:${port}`);
  return pool;
};

module.exports = { connectToUserDatabase };