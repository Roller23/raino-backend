const {v4: uuidv4} = require('uuid');
const uniqid = require('uniqid');
const emailValidator = require("email-validator");
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt');
const hash = require('password-hash');
const MongoClient = require('mongodb').MongoClient;
const moment = require('moment-timezone');
const rateLimit = require("express-rate-limit");
const express = require('express')
const app = express();
const http = require('http').Server(app);
const Mutex = require('async-mutex').Mutex;
const fetch = require('node-fetch');
const io = require('socket.io')(http, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const serverTimezone = moment.tz.guess();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  host: 'smtp.gmail.com',
  auth: {
    type: "login",
    user: 'rainochat@gmail.com',
    pass: process.env.MAIL_PASS
  }
});

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

function connectToDb() {
  return new Promise(resolve => {
    const uri = `mongodb+srv://RainingDiamonds:${process.env.MONGO_PASS}@raino-main.mkc5h.mongodb.net/mainDB?retryWrites=true&w=majority`;
    const client = new MongoClient(uri, {useNewUrlParser: true, useUnifiedTopology: true});
    client.connect(err => {
      if (err) return resolve({err: err, db: null});
      resolve({err: null, db: client.db("mainDB")});
    });
  });
}

function sendMail(to, subject, text) {
  return new Promise(resolve => {
    const mailOptions = {
      from: 'rainochat@gmail.com', to, subject, text
    };
    transporter.sendMail(mailOptions, (error, info) => {
      resolve(error);
    });
  });
}

async function generateUniqueID(db) {
  while (true) {
    const id = uniqid();
    const user = await db.collection('accounts').findOne({uniqid: id});
    if (!user) {
      return id;
    }
  }
}

function generateNicknameTag(db, nickname) {
  return new Promise(resolve => {
    db.collection('accounts').find({nickname: nickname}).toArray(async (err, res) => {
      if (err) {
        return resolve({success: false, err: err, reason: 'db'});
      }
      if (res.length > 8000) {
        return resolve({success: false, err: err, reason: 'limit reached'});
      }
      while (true) {
        const tag = rand(1, 9999);
        const exists = await db.collection('accounts').findOne({tag: tag, nickname: nickname});
        if (!exists) {
          return resolve({success: true, tag: tag});
        }
      }
    });
  });
}

(async () => {
  const {err, db} = await connectToDb();
  
  if (err) throw err;
  
  const limiter = rateLimit({
    windowMs: 60 * 1000 * 1, // 1 minute
    max: 30 // limit 30 requests per window
  });

  app.use(limiter); // apply to all requests
  
  app.use(express.urlencoded({extended: true}));
  app.use(express.json());
  
  const mutex = new Mutex();
  
  app.get('/', (req, res) => {
    res.send('hey babe');
  });
  
  app.post('/register', async (req, res) => {
    // TODO
    // doesnt work cause gmail enforces 2f auth or something
    // const opt = {
    //   to: 'roller47@wp.pl',
    //   subject: 'Raino Chat account confirmation',
    //   text: 'Hey babe'
    // };
    // const err = await sendMail(opt.to, opt.subject, opt.text);
    // if (err) {
    //   console.log(err);
    //   return res.send(JSON.stringify({success: false}));
    // }
    if (!req.body.email || !req.body.password || !req.body.nickname) {
      return res.json({
        success: false,
        msg: 'incomplete query'
      });
    }
    req.body.nickname = req.body.nickname.trim()
    if (req.body.nickname.length > 20 || req.body.nickname.length < 1) {
      return res.json({
        success: false,
        msg: 'nickname too long or short'
      });
    }
    if (!emailValidator.validate(req.body.email)) {
      return res.json({
        success: false,
        msg: 'invalid email address'
      });
    }
    if (req.body.password.length > 50 || req.body.password.length < 3) {
      return res.json({
        success: false,
        msg: 'password too long or short'
      });
    }
    await mutex.runExclusive(async () => {
      const tagRes = await generateNicknameTag(db, req.body.nickname);
      if (!tagRes.success) {
        if (tagRes.reason === 'db') {
          return res.json({
            success: false,
            msg: 'database error'
          });
        }
        return res.json({
          success: false,
          msg: 'nickname limit reached'
        });
      }
      const emailExists = await db.collection('accounts').findOne({email: req.body.email});
      if (emailExists) {
        return res.json({
          success: false,
          msg: 'email exists'
        });
      }
      const nicknameTag = tagRes.tag;
      const hashedPassword = await bcrypt.hash(req.body.password, 9);
      const uniqID = await generateUniqueID(db);
      const newUser = {
        email: req.body.email,
        password: hashedPassword,
        nickname: req.body.nickname,
        uniqid: uniqID,
        verified: false,
        tag: nicknameTag,
        tokenSelector: null,
        token: null,
        tokenTimestamp: null
      };
      const {err, result} = await db.collection('accounts').insertOne(newUser);
      if (err) {
        console.log(err);
        return res.json({success: false, msg: 'database error'});
      }
      res.json({success: true});
    });
  });
  
  app.post('/login', async (req, res) => {
    if (!req.body.email || !req.body.password) {
      return res.json({
        success: false,
        msg: 'incomplete query'
      });
    }
    if (!emailValidator.validate(req.body.email)) {
      return res.json({
        success: false,
        msg: 'invalid email address'
      });
    }
    const user = await db.collection('accounts').findOne({email: req.body.email});
    if (!user) {
      return res.json({
        success: false,
        msg: 'incorrect email or password'
      });
    }
    const passwordMatch = await bcrypt.compare(req.body.password, user.password);
    if (!passwordMatch) {
      return res.json({
        success: false,
        msg: 'incorrect email or password'
      });
    }
    const token = uuidv4();
    const tokenSelector = uuidv4();
    const hashedToken = hash.generate(token);
    await db.collection('accounts').updateOne({_id: user._id}, {$set: {
      token: hashedToken,
      tokenTimestamp: Date.now(),
      tokenSelector: tokenSelector
    }})
    res.json({success: true, token: token, selector: tokenSelector});
  });
  
  io.on('connection', socket => {
    console.log('socket connected');
    
    socket._storage = {}
    // give socket 10 seconds to authenticate
    socket._storage.timeout = setTimeout(() => {
      console.log('force disconnect due to inactivity')
      socket.disconnect(true);
    }, 1000 * 10);
    
    socket.on('disconnect', () => {
      console.log('socket disconnected')
    });
    
    socket.on('authenticate', async data => {
      if (!data || !data.selector || !data.token) return;
      const user = await db.collection('accounts').findOne({tokenSelector: data.selector});
      if (!user) {
        // unknown token selector
        return socket.emit('auth denied');
      }
      if (!hash.verify(data.token, user.token)) {
        return socket.emit('auth denied');
      }
      socket._storage.user = user;
      clearTimeout(socket._storage.timeout);
      socket.emit('authenticated');
      console.log(user.email + ' authenticated');
      
      socket.join('GENERAL_CHANNEL');
      
      const searchBy = {channel: 'GENERAL_CHANNEL', server: 'GENERAL_SERVER'};
      const generalMessages = await db
        .collection('messages')
        .find(searchBy)
        .sort({$natural: -1})
        .limit(50)
        .toArray();
      
      generalMessages.reverse()
      
      socket.emit('channel messages', {messages: generalMessages, channel: 'GENERAL_CHANNEL'});
      
      socket.on('message', async data => {
        if (typeof data !== 'object') return;
        if (data.message.startsWith('/raingo ')) {
          const raingoMessage = data.message.replace('/raingo ', '')
          const raingoData = {
            nickname: socket._storage.user.nickname,
            msg: raingoMessage,
            channel: data.channel
          };
          await fetch('https://raingo.herokuapp.com/api/raino', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(raingoData)
          });
          socket.emit('raingo forwarded')
          return;
        }
        const newMessage = {
          message: data.message,
          channel: data.channel,
          server: 'GENERAL_SERVER',
          from: socket._storage.user.nickname,
          date: new Date(),
          timezone: serverTimezone,
          userID: socket._storage.user.uniqid
        };
        const {err, res} = await db.collection('messages').insertOne(newMessage);
        if (err) {
          console.error(err);
          return;
        }
        io.to('GENERAL_CHANNEL').emit('message', newMessage);
      });
      
    });
    
    socket.emit('connected')
    
  });
  
  const PORT = process.env.PORT || 3000;
  
  http.listen(PORT, () => {
    console.log('listening on port ' + PORT);
  });
  
})();