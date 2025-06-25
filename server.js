// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const expressLayouts = require('express-ejs-layouts');
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
app.use(expressLayouts);
app.set('layout', 'layout');

// Helper function to format file size (needed for EJS template)
app.locals.formatFileSize = function(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

// Helper function to determine if file is video or audio
function getFileType(mimetype, filename) {
  const ext = path.extname(filename).toLowerCase();
  
  // Video formats
  const videoExts = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.3gp'];
  // Audio formats
  const audioExts = ['.mp3', '.wav', '.m4a', '.aac', '.ogg'];
  // Image formats (treated as video for streaming)
  const imageExts = ['.jpeg', '.jpg', '.png', '.gif'];
  
  if (videoExts.includes(ext) || imageExts.includes(ext) || mimetype.startsWith('video/') || mimetype.startsWith('image/')) {
    return 'video';
  } else if (audioExts.includes(ext) || mimetype.startsWith('audio/')) {
    return 'audio';
  }
  
  return 'unknown';
}

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const streamId = req.params.streamId || req.body.streamId;
    const fileType = getFileType(file.mimetype, file.originalname);
    const streamDir = path.join(UPLOADS_DIR, streamId);
    const typeDir = path.join(streamDir, fileType === 'video' ? 'video' : 'audio');
    
    console.log('Upload destination:', { streamId, fileType, typeDir });
    
    fs.ensureDirSync(typeDir);
    cb(null, typeDir);
  },
  filename: (req, file, cb) => {
    // Use timestamp + original name for uniqueness
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /mp4|jpeg|jpg|png|gif|mp3|mpeg|wav|avi|mov|wmv|flv|webm|m4a|aac|mkv|ogg|3gp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    console.log('File filter:', {
      filename: file.originalname,
      mimetype: file.mimetype,
      extname: path.extname(file.originalname).toLowerCase(),
      allowed: mimetype && extname,
      type: getFileType(file.mimetype, file.originalname)
    });
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only audio and video files are allowed! Supported formats: MP4, MP3, WAV, AVI, MOV, WMV, FLV, WebM, M4A, AAC, MKV, OGG, 3GP'));
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

app.get('/stream/:streamId', async (req, res) => {
  const { streamId } = req.params;
  console.log('Accessing stream:', streamId);
  
  const streamDir = path.join(UPLOADS_DIR, streamId);
  
  if (!fs.existsSync(streamDir)) {
    return res.redirect('/?error=Stream not found');
  }

  const files = getStreamFiles(streamId);
  console.log('Stream files:', files);
  
  let totalSize = 0;
  files.video.forEach(file => totalSize += file.size);
  files.audio.forEach(file => totalSize += file.size);
  
  const status = streamStatus.get(streamId) || 'created';
  console.log("Status:", status);
  
  res.render('stream', {
    title: `Stream: ${streamId}`,
    streamId,
    files,
    status,
    totalSize
  });
});

app.post('/create-stream', (req, res) => {
  const { streamId } = req.body;
  
  if (!streamId || streamId.trim() === '') {
    return res.redirect('/?error=Stream ID is required');
  }

  // Validate stream ID (alphanumeric and dashes only)
  if (!/^[a-zA-Z0-9-_]+$/.test(streamId)) {
    return res.redirect('/?error=Stream ID can only contain letters, numbers, hyphens, and underscores');
  }

  const streamDir = path.join(UPLOADS_DIR, streamId);
  
  if (fs.existsSync(streamDir)) {
    return res.redirect('/?error=Stream ID already exists');
  }

  try {
    fs.ensureDirSync(streamDir);
    fs.ensureDirSync(path.join(streamDir, 'video'));
    fs.ensureDirSync(path.join(streamDir, 'audio'));
    streamStatus.set(streamId, 'created');
    console.log('Created new stream with video/audio folders:', streamId);
    
    res.redirect(`/stream/${streamId}`);
  } catch (error) {
    console.error('Error creating stream:', error);
    res.redirect('/?error=Failed to create stream');
  }
});

app.post('/upload/:streamId', upload.array('files', 10), (req, res) => {
  const { streamId } = req.params;
  console.log('Upload request for stream:', streamId);
  
  if (!req.files || req.files.length === 0) {
    return res.redirect(`/stream/${streamId}?error=No files uploaded`);
  }

  const uploadSummary = req.files.reduce((acc, file) => {
    const fileType = getFileType(file.mimetype, file.originalname);
    acc[fileType] = (acc[fileType] || 0) + 1;
    return acc;
  }, {});

  console.log('Uploaded files summary:', uploadSummary);
  const message = `${req.files.length} files uploaded successfully (${uploadSummary.video || 0} video, ${uploadSummary.audio || 0} audio)`;
  res.redirect(`/stream/${streamId}?success=${encodeURIComponent(message)}`);
});

app.post('/start-stream', (req, res) => {
  const { streamId, rtmpUrl, streamKey } = req.body;
  
  console.log('Start stream request:', { streamId, rtmpUrl, streamKey });
  
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
  if (files.video.length === 0 && files.audio.length === 0) {
    return res.json({ 
      success: false, 
      message: 'No media files found for this stream' 
    });
  }

  try {
    startStreaming(streamId, rtmpUrl, streamKey, files);
    
    res.json({ 
      success: true, 
      message: 'Stream started successfully' 
    });
  } catch (error) {
    console.error('Error starting stream:', error);
    res.json({ 
      success: false, 
      message: 'Failed to start stream: ' + error.message 
    });
  }
});

app.post('/stop-stream/:streamId', (req, res) => {
  const { streamId } = req.params;
  
  console.log('Stop stream request:', streamId);
  
  try {
    stopStreaming(streamId);
    
    res.json({ 
      success: true, 
      message: 'Stream stopped successfully' 
    });
  } catch (error) {
    console.error('Error stopping stream:', error);
    res.json({ 
      success: false, 
      message: 'Failed to stop stream: ' + error.message 
    });
  }
});

app.post('/restart-stream/:streamId', (req, res) => {
  const { streamId } = req.params;
  const { rtmpUrl, streamKey } = req.body;
  
  console.log('Restart stream request:', streamId);
  
  if (!rtmpUrl || !streamKey) {
    return res.json({ 
      success: false, 
      message: 'RTMP URL and Stream Key are required' 
    });
  }
  
  try {
    // Stop current stream
    stopStreaming(streamId);
    
    // Wait a moment then restart
    setTimeout(() => {
      const files = getStreamFiles(streamId);
      if (files.video.length > 0 || files.audio.length > 0) {
        startStreaming(streamId, rtmpUrl, streamKey, files);
      }
    }, 2000);
    
    res.json({ 
      success: true, 
      message: 'Stream restarted successfully' 
    });
  } catch (error) {
    console.error('Error restarting stream:', error);
    res.json({ 
      success: false, 
      message: 'Failed to restart stream: ' + error.message 
    });
  }
});

app.delete('/delete-file/:streamId/:type/:filename', (req, res) => {
  const { streamId, type, filename } = req.params;
  const filePath = path.join(UPLOADS_DIR, streamId, type, filename);
  
  console.log('Delete file request:', { streamId, type, filename, filePath });
  
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log('File deleted successfully:', filename);
      res.json({ success: true, message: 'File deleted successfully' });
    } else {
      res.json({ success: false, message: 'File not found' });
    }
  } catch (error) {
    console.error('Error deleting file:', error);
    res.json({ success: false, message: 'Error deleting file: ' + error.message });
  }
});

// API endpoints for stream management
app.get('/api/stream/:streamId/status', (req, res) => {
  const { streamId } = req.params;
  const status = streamStatus.get(streamId) || 'not_found';
  const files = getStreamFiles(streamId);
  
  res.json({
    streamId,
    status,
    videoFileCount: files.video.length,
    audioFileCount: files.audio.length,
    isStreaming: streamingProcesses.has(streamId)
  });
});

app.get('/api/streams', (req, res) => {
  res.json({
    streams: getActiveStreams(),
    totalStreams: streamStatus.size
  });
});

// Helper functions
function getActiveStreams() {
  try {
    const streams = fs.readdirSync(UPLOADS_DIR);
    return streams.map(streamId => {
      const files = getStreamFiles(streamId);
      return {
        id: streamId,
        status: streamStatus.get(streamId) || 'created',
        videoFileCount: files.video.length,
        audioFileCount: files.audio.length,
        isStreaming: streamingProcesses.has(streamId)
      };
    });
  } catch (error) {
    console.error('Error getting active streams:', error);
    return [];
  }
}

function getStreamFiles(streamId) {
  const result = { video: [], audio: [] };
  
  try {
    const streamDir = path.join(UPLOADS_DIR, streamId);
    if (!fs.existsSync(streamDir)) return result;
    
    // Get video files
    const videoDir = path.join(streamDir, 'video');
    if (fs.existsSync(videoDir)) {
      result.video = fs.readdirSync(videoDir)
        .filter(file => {
          const ext = path.extname(file).toLowerCase();
          return ['.mp4', '.jpeg', '.jpg', '.png', '.gif', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.3gp'].includes(ext);
        })
        .map(file => {
          const filePath = path.join(videoDir, file);
          const stats = fs.statSync(filePath);
          return {
            name: file,
            path: filePath,
            size: stats.size,
            modified: stats.mtime,
            type: 'video'
          };
        })
        .sort((a, b) => a.modified - b.modified);
    }
    
    // Get audio files
    const audioDir = path.join(streamDir, 'audio');
    if (fs.existsSync(audioDir)) {
      result.audio = fs.readdirSync(audioDir)
        .filter(file => {
          const ext = path.extname(file).toLowerCase();
          return ['.mp3', '.wav', '.m4a', '.aac', '.ogg'].includes(ext);
        })
        .map(file => {
          const filePath = path.join(audioDir, file);
          const stats = fs.statSync(filePath);
          return {
            name: file,
            path: filePath,
            size: stats.size,
            modified: stats.mtime,
            type: 'audio'
          };
        })
        .sort((a, b) => a.modified - b.modified);
    }
    
  } catch (error) {
    console.error('Error getting stream files:', error);
  }
  
  return result;
}

function startStreaming(streamId, rtmpUrl, streamKey, files) {
  const fullRtmpUrl = `${rtmpUrl}/${streamKey}`;
  
  console.log('Starting 1080p stream:', {
    streamId,
    rtmpUrl: fullRtmpUrl,
    videoCount: files.video.length,
    audioCount: files.audio.length
  });

  // Create playlist files for both video and audio
  const videoPlaylistPath = path.join(STREAMS_DIR, `${streamId}_video_playlist.txt`);
  const audioPlaylistPath = path.join(STREAMS_DIR, `${streamId}_audio_playlist.txt`);

  let ffmpegCommand = ffmpeg();
  let inputIndex = 0;
  
  // Handle video files
  if (files.video.length > 0) {
    const videoPlaylistContent = files.video.map(file => 
      `file '${file.path.replace(/'/g, "\\'")}'`
    ).join('\n');
    fs.writeFileSync(videoPlaylistPath, videoPlaylistContent);
    console.log('Video playlist created:', videoPlaylistPath);
    
    ffmpegCommand = ffmpegCommand
      .input(videoPlaylistPath)
      .inputOptions([
        '-f concat',
        '-safe 0',
        '-stream_loop -1',
        '-re'
      ]);
    inputIndex++;
  }
  
  // Handle audio files
  if (files.audio.length > 0) {
    const audioPlaylistContent = files.audio.map(file => 
      `file '${file.path.replace(/'/g, "\\'")}'`
    ).join('\n');
    fs.writeFileSync(audioPlaylistPath, audioPlaylistContent);
    console.log('Audio playlist created:', audioPlaylistPath);
    
    ffmpegCommand = ffmpegCommand
      .input(audioPlaylistPath)
      .inputOptions([
        '-f concat',
        '-safe 0',
        '-stream_loop -1',
        '-re'
      ]);
    inputIndex++;
  }

  // Configure output based on what inputs we have
  if (files.video.length > 0 && files.audio.length > 0) {
    // Both video and audio - mix them at 1080p
    ffmpegCommand = ffmpegCommand
      .complexFilter([
        '[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2[video]',
        '[1:a]volume=1[audio]'
      ])
      .map('[video]')
      .map('[audio]');
  } else if (files.video.length > 0) {
    // Only video - use video audio if available, otherwise add silence at 1080p
    ffmpegCommand = ffmpegCommand
      .videoFilter('scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2')
      .audioCodec('aac')
      .audioFrequency(44100);
  } else if (files.audio.length > 0) {
    // Only audio - create a blank 1080p video with the audio
    ffmpegCommand = ffmpegCommand
      .inputOptions(['-f lavfi', '-i color=c=black:s=1920x1080:r=30'])
      .complexFilter([
        '[1:a]volume=1[audio]'
      ])
      .map('0:v')
      .map('[audio]');
  }

  ffmpegCommand = ffmpegCommand
    .videoCodec('libx264')
    .audioCodec('aac')
    .format('flv')
    .outputOptions([
      '-preset veryfast',
      '-tune zerolatency',
      '-b:v 4500k',        // Increased bitrate for 1080p
      '-maxrate 4500k',    // Increased max bitrate for 1080p
      '-bufsize 9000k',    // Increased buffer size for 1080p
      '-b:a 128k',
      '-ar 44100',
      '-g 60',
      '-keyint_min 60',
      '-sc_threshold 0',
      '-f flv',
      '-reconnect 1',
      '-reconnect_at_eof 1',
      '-reconnect_streamed 1',
      '-reconnect_delay_max 2'
    ])
    .output(fullRtmpUrl);

  ffmpegCommand
    .on('start', (commandLine) => {
      console.log(`Stream ${streamId} started with command: ${commandLine}`);
      streamStatus.set(streamId, 'streaming');
      io.emit('streamStatus', { streamId, status: 'streaming' });
    })
    .on('progress', (progress) => {
      io.emit('streamProgress', { 
        streamId, 
        progress: {
          frames: progress.frames,
          currentFps: progress.currentFps,
          currentKbps: progress.currentKbps,
          targetSize: progress.targetSize,
          timemark: progress.timemark
        }
      });
    })
    .on('error', (err) => {
      console.error(`Stream ${streamId} error:`, err.message);
      streamStatus.set(streamId, 'error');
      streamingProcesses.delete(streamId);
      io.emit('streamStatus', { streamId, status: 'error', message: err.message });
      
      // Clean up playlist files
      cleanupPlaylistFiles(streamId);
    })
    .on('end', () => {
      console.log(`Stream ${streamId} ended`);
      streamStatus.set(streamId, 'stopped');
      streamingProcesses.delete(streamId);
      io.emit('streamStatus', { streamId, status: 'stopped' });
      
      // Clean up playlist files
      cleanupPlaylistFiles(streamId);
    });

  ffmpegCommand.run();
  streamingProcesses.set(streamId, ffmpegCommand);
}

function stopStreaming(streamId) {
  const process = streamingProcesses.get(streamId);
  if (process) {
    console.log('Stopping stream:', streamId);

    try {
      process.kill('SIGTERM');

      setTimeout(() => {
        if (streamingProcesses.has(streamId)) {
          console.log('Force killing stream:', streamId);
          process.kill('SIGKILL');
        }
      }, 5000);
    } catch (e) {
      console.error('Failed to kill FFmpeg process:', e.message);
    }

    streamStatus.set(streamId, 'stopped');
    streamingProcesses.delete(streamId);
    io.emit('streamStatus', { streamId, status: 'stopped' });

    cleanupPlaylistFiles(streamId);
  }
}

function cleanupPlaylistFiles(streamId) {
  const videoPlaylistPath = path.join(STREAMS_DIR, `${streamId}_video_playlist.txt`);
  const audioPlaylistPath = path.join(STREAMS_DIR, `${streamId}_audio_playlist.txt`);
  
  [videoPlaylistPath, audioPlaylistPath].forEach(filePath => {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  });
}

// Socket.IO for real-time updates
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  const streams = getActiveStreams();
  socket.emit('allStreamStatus', streams);
  
  socket.on('joinStream', (streamId) => {
    socket.join(`stream_${streamId}`);
    console.log(`Client ${socket.id} joined stream ${streamId}`);
  });
  
  socket.on('leaveStream', (streamId) => {
    socket.leave(`stream_${streamId}`);
    console.log(`Client ${socket.id} left stream ${streamId}`);
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Express error:', error);
  
  if (error instanceof multer.MulterError) {
    let message = 'Upload error: ';
    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        message += 'File too large. Maximum size is 500MB.';
        break;
      case 'LIMIT_FILE_COUNT':
        message += 'Too many files. Maximum is 10 files per upload.';
        break;
      case 'LIMIT_UNEXPECTED_FILE':
        message += 'Unexpected file field.';
        break;
      default:
        message += error.message;
    }
    
    if (req.params && req.params.streamId) {
      return res.redirect(`/stream/${req.params.streamId}?error=${encodeURIComponent(message)}`);
    }
    return res.redirect(`/?error=${encodeURIComponent(message)}`);
  }
  
  const message = error.message || 'An unexpected error occurred';
  if (req.params && req.params.streamId) {
    return res.redirect(`/stream/${req.params.streamId}?error=${encodeURIComponent(message)}`);
  }
  res.redirect(`/?error=${encodeURIComponent(message)}`);
});

// 404 handler
app.use((req, res) => {
  res.status(404).render('error', { 
    title: '404 - Page Not Found',
    message: 'The page you are looking for does not exist.',
    error: { status: 404 }
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Live Streaming Server running on port ${PORT}`);
  console.log(`📺 Access the application at http://localhost:${PORT}`);
  console.log(`📁 Uploads directory: ${UPLOADS_DIR}`);
  console.log(`🎬 Streams directory: ${STREAMS_DIR}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n⏹️  Shutting down gracefully...');
  
  console.log(`🛑 Stopping ${streamingProcesses.size} active streams...`);
  for (let [streamId, process] of streamingProcesses) {
    console.log(`  Stopping stream: ${streamId}`);
    process.kill('SIGTERM');
  }
  
  setTimeout(() => {
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  }, 3000);
});

process.on('SIGTERM', () => {
  console.log('📡 SIGTERM received, shutting down...');
  process.kill(process.pid, 'SIGINT');
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});