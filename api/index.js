// api/index.js
const express = require('express');
const app = express();

app.get('/api/data', (req, res) => {
  res.json({ message: 'Halo dari Vercel Serverless!' });
});

module.exports = app;
