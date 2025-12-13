const mssql = require('mssql');
require('dotenv').config();

let cachedPool = null;

const connectToDatabase = async () => {
  if (cachedPool && cachedPool.connected) {
    try {
      await cachedPool.request().query('SELECT 1');
      return cachedPool;
    } catch (err) {
      console.warn('Main pool stale, reconnecting...');
      await cachedPool.close();
      cachedPool = null;
    }
  }

  const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER, // 173.208.167.190
    database: process.env.DB_DATABASE1, // RTPOS_MAIN
    port: parseInt(process.env.PORT),
    options: { encrypt: false, trustServerCertificate: true },
    requestTimeout: 15000,
  };

  const pool = await new mssql.ConnectionPool(config).connect();
  cachedPool = pool;
  console.log('Connected to MAIN DB:', config.server, config.port);
  return pool;
};

module.exports = { connectToDatabase };