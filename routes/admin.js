const express = require('express');
const router = express.Router();
const { Settings } = require('../models');

router.post('/set-edge', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.BOT_TOKEN) {
    return res.status(403).json({error: 'Forbidden'});
  }
  
  const {edge} = req.body;
  if (typeof edge !== 'number' || edge < 0 || edge > 0.5) {
    return res.status(400).json({error: 'Invalid edge value'});
  }
  
  await Settings.updateOne({}, {houseEdge: edge}, {upsert: true});
  res.json({success: true, houseEdge: edge});
});

router.get('/edge', async (req, res) => {
  const s = await Settings.findOne();
  res.json({houseEdge: s?.houseEdge || 0.05});
});

module.exports = router;
