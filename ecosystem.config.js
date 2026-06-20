// PM2 process definition for the Hostinger VPS.
//   pm2 start ecosystem.config.js
//   pm2 logs staff-attendance-bot
//   pm2 save && pm2 startup   (to survive reboots)
module.exports = {
  apps: [
    {
      name: 'staff-attendance-bot',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      watch: false,
      time: true,
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
