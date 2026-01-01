require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
mongoose.connect(process.env.MONGO_URI);
const { User, Invoice, SlotRound } = require('./models');
const playRouter = require('./routes/play');
const slotsRouter = require('./routes/slots');
const axios = require('axios');

app.use('/fair', playRouter);
app.use('/', slotsRouter);

app.post('/play', async (req, res) => {
  const {uid, bet, side, refCode} = req.body;
  const {data} = await axios.post('https://pay.crypt.bot/api/createInvoice', {
    asset: 'USDT', amount: String(bet), description: `Bet ${bet} USDT`
  }, {headers: {'Crypto-Pay-API-Token': process.env.CRYPTO_TOKEN}});
  await Invoice.create({iid: data.result.invoice_id, uid, bet, side});
  res.json({invoiceUrl: data.result.pay_url});
});

app.post('/webhook', async (req, res) => {
  const {update} = req.body;
  if (update?.type !== 'invoice_paid') return res.sendStatus(200);
  const {invoice_id} = update.payload;
  const inv = await Invoice.findOneAndUpdate({iid: invoice_id}, {status: 'paid'});
  if (!inv) return res.sendStatus(200);
  const r = await SlotRound.findOne({invoiceId: invoice_id});
  if (r) { r.paid = true; await r.save(); }
  res.sendStatus(200);
});

app.get('/user/:uid', async (req, res) => {
  const u = await User.findOneAndUpdate({uid: +req.params.uid}, {}, {upsert: true, new: true});
  res.json({balance: u.balance, refCode: u.uid, refCount: await User.countDocuments({ref: u.uid}), refEarn: u.refEarn, lastBonus: u.lastBonus});
});

app.post('/bonus', async (req, res) => {
  const {uid, now} = req.body;
  await User.updateOne({uid}, {lastBonus: now, $inc: {balance: 0.2}});
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server on ' + PORT));