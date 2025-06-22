
  // server.js
  const express = require('express');
  const http = require('http');
  const socketIo = require('socket.io');
  const multer = require('multer');
  const path = require('path');
  const fs = require('fs-extra');
  const { v4: uuidv4 } = require('uuid');
  const ffmpeg = require('fluent-ffmpeg');
  const cors = require('cors');
  
  const app = express();
  const server = http.createServer(app);
  const io = socketIo(server);
  
  // Configuration
  const PORT = process.env.PORT || 3000;
  const UPLOADS_DIR = path.join(__dirname, 'uploads');
  const STREAMS_DIR = path.join(__dirname, 'streams');
  
  // Ensure directories exist
  fs.ensureDirSync(UPLOADS_DIR);
  fs.ensureDirSync(STREAMS_DIR);
  
  // Global streaming processes
  const streamingProcesses = new Map();
  const streamStatus = new Map();
  
  // Middleware
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static('public'));
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  
  // Multer configuration for file uploads
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const streamId = req.params.streamId || req.body.streamId;
      const streamDir = path.join(UPLOADS_DIR, streamId);
      fs.ensureDirSync(streamDir);
      cb(null, streamDir);
    },
    filename: (req, file, cb) => {
      cb(null, Date.now() + '-' + file.originalname);
    }
  });
  
  const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
      const allowedTypes = /mp4|mp3|wav|avi|mov|wmv|flv|webm|m4a|aac/;
      const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
      const mimetype = allowedTypes.test(file.mimetype);
      
      if (mimetype && extname) {
        return cb(null, true);
      } else {
        cb(new Error('Only audio and video files are allowed!'));
      }
    }
  });
  
  // Routes
  app.get('/', (req, res) => {
    res.render('index', { 
      title: 'Live Streaming Server',
      streams: getActiveStreams()
    });
  });
  
  app.get('/stream/:streamId', (req, res) => {
    const { streamId } = req.params;
    const streamDir = path.join(UPLOADS_DIR, streamId);
    
    if (!fs.existsSync(streamDir)) {
      return res.redirect('/?error=Stream not found');
    }
  
    const files = getStreamFiles(streamId);
    const status = streamStatus.get(streamId) || 'stopped';
    
    res.render('stream', {
      title: `Stream: ${streamId}`,
      streamId,
      files,
      status
    });
  });
  
  app.post('/create-stream', (req, res) => {
    const { streamId } = req.body;
    
    if (!streamId || streamId.trim() === '') {
      return res.redirect('/?error=Stream ID is required');
    }
  
    const streamDir = path.join(UPLOADS_DIR, streamId);
    
    if (fs.existsSync(streamDir)) {
      return res.redirect('/?error=Stream ID already exists');
    }
  
    fs.ensureDirSync(streamDir);
    streamStatus.set(streamId, 'created');
    
    res.redirect(`/stream/${streamId}`);
  });
  
  app.post('/upload/:streamId', upload.array('files', 10), (req, res) => {
    const { streamId } = req.params;
    
    if (!req.files || req.files.length === 0) {
      return res.redirect(`/stream/${streamId}?error=No files uploaded`);
    }
  
    res.redirect(`/stream/${streamId}?success=Files uploaded successfully`);
  });
  
  app.post('/start-stream/:streamId', (req, res) => {
    const { streamId } = req.params;
    const { rtmpUrl, streamKey } = req.body;
    
    if (!rtmpUrl || !streamKey) {
      return res.json({ 
        success: false, 
        message: 'RTMP URL and Stream Key are required' 
      });
    }
  
    if (streamingProcesses.has(streamId)) {
      return res.json({ 
        success: false, 
        message: 'Stream is already running' 
      });
    }
  
    const files = getStreamFiles(streamId);
    if (files.length === 0) {
      return res.json({ 
        success: false, 
        message: 'No media files found for this stream' 
      });
    }
  
    startStreaming(streamId, rtmpUrl, streamKey, files);
    
    res.json({ 
      success: true, 
      message: 'Stream started successfully' 
    });
  });
  
  app.post('/stop-stream/:streamId', (req, res) => {
    const { streamId } = req.params;
    
    stopStreaming(streamId);
    
    res.json({ 
      success: true, 
      message: 'Stream stopped successfully' 
    });
  });
  
  app.post('/restart-stream/:streamId', (req, res) => {
    const { streamId } = req.params;
    const { rtmpUrl, streamKey } = req.body;
    
    // Stop current stream
    stopStreaming(streamId);
    
    // Wait a moment then restart
    setTimeout(() => {
      const files = getStreamFiles(streamId);
      if (files.length > 0) {
        startStreaming(streamId, rtmpUrl, streamKey, files);
      }
    }, 2000);
    
    res.json({ 
      success: true, 
      message: 'Stream restarted successfully' 
    });
  });
  
  app.delete('/delete-file/:streamId/:filename', (req, res) => {
    const { streamId, filename } = req.params;
    const filePath = path.join(UPLOADS_DIR, streamId, filename);
    
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        res.json({ success: true, message: 'File deleted successfully' });
      } else {
        res.json({ success: false, message: 'File not found' });
      }
    } catch (error) {
      res.json({ success: false, message: 'Error deleting file' });
    }
  });
  
  // Helper functions
  function getActiveStreams() {
    try {
      const streams = fs.readdirSync(UPLOADS_DIR);
      return streams.map(streamId => ({
        id: streamId,
        status: streamStatus.get(streamId) || 'created',
        fileCount: getStreamFiles(streamId).length
      }));
    } catch (error) {
      return [];
    }
  }
  
  function getStreamFiles(streamId) {
    try {
      const streamDir = path.join(UPLOADS_DIR, streamId);
      if (!fs.existsSync(streamDir)) return [];
      
      return fs.readdirSync(streamDir)
        .filter(file => {
          const ext = path.extname(file).toLowerCase();
          return ['.mp4', '.mp3', '.wav', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4a', '.aac'].includes(ext);
        })
        .map(file => ({
          name: file,
          path: path.join(streamDir, file),
          size: fs.statSync(path.join(streamDir, file)).size
        }));
    } catch (error) {
      return [];
    }
  }
  
  function startStreaming(streamId, rtmpUrl, streamKey, files) {
    const fullRtmpUrl = `${rtmpUrl}/${streamKey}`;
    
    // Create playlist file for looping
    const playlistPath = path.join(STREAMS_DIR, `${streamId}_playlist.txt`);
    const playlistContent = files.map(file => `file '${file.path.replace(/'/g, "\\'")}'`).join('\n');
    fs.writeFileSync(playlistPath, playlistContent);
  
    // FFmpeg command for streaming with loop
    const ffmpegCommand = ffmpeg()
      .input(playlistPath)
      .inputOptions([
        '-f concat',
        '-safe 0',
        '-stream_loop -1' // Loop indefinitely
      ])
      .videoCodec('libx264')
      .audioCodec('aac')
      .format('flv')
      .outputOptions([
        '-preset veryfast',
        '-tune zerolatency',
        '-vf scale=1280:720',
        '-b:v 2500k',
        '-maxrate 2500k',
        '-bufsize 5000k',
        '-b:a 128k',
        '-ar 44100',
        '-g 60',
        '-keyint_min 60',
        '-sc_threshold 0',
        '-f flv'
      ])
      .output(fullRtmpUrl);
  
    ffmpegCommand
      .on('start', (commandLine) => {
        console.log(`Stream ${streamId} started: ${commandLine}`);
        streamStatus.set(streamId, 'streaming');
        io.emit('streamStatus', { streamId, status: 'streaming' });
      })
      .on('error', (err) => {
        console.error(`Stream ${streamId} error:`, err.message);
        streamStatus.set(streamId, 'error');
        streamingProcesses.delete(streamId);
        io.emit('streamStatus', { streamId, status: 'error', message: err.message });
      })
      .on('end', () => {
        console.log(`Stream ${streamId} ended`);
        streamStatus.set(streamId, 'stopped');
        streamingProcesses.delete(streamId);
        io.emit('streamStatus', { streamId, status: 'stopped' });
      });
  
    ffmpegCommand.run();
    streamingProcesses.set(streamId, ffmpegCommand);
  }
  
  function stopStreaming(streamId) {
    const process = streamingProcesses.get(streamId);
    if (process) {
      process.kill('SIGKILL');
      streamingProcesses.delete(streamId);
      streamStatus.set(streamId, 'stopped');
      io.emit('streamStatus', { streamId, status: 'stopped' });
      
      // Clean up playlist file
      const playlistPath = path.join(STREAMS_DIR, `${streamId}_playlist.txt`);
      if (fs.existsSync(playlistPath)) {
        fs.unlinkSync(playlistPath);
      }
    }
  }
  
  // Socket.IO for real-time updates
  io.on('connection', (socket) => {
    console.log('Client connected');
    
    socket.on('disconnect', () => {
      console.log('Client disconnected');
    });
  });
  
  // Error handling
  app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
      return res.redirect('back?error=' + encodeURIComponent(error.message));
    }
    next(error);
  });
  
  // Start server
  server.listen(PORT, () => {
    console.log(`Live Streaming Server running on port ${PORT}`);
    console.log(`Access the application at http://localhost:${PORT}`);
  });
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    
    // Stop all streaming processes
    for (let [streamId, process] of streamingProcesses) {
      process.kill('SIGKILL');
    }
    
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
  
  
