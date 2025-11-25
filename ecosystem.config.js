// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "retailtarget-sync",
      script: "server.js",                    // Your main file
      cwd: "D:/src/SyncDB",           // CHANGE THIS TO YOUR PROJECT PATH
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      time: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      env: {
        NODE_ENV: "production",
        PORT: 8010
      }
    }
  ]
};