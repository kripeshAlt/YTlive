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

// Enhanced file type detection with better image handling
function getFileType(mimetype, filename) {
  const ext = path.extname(filename).toLowerCase();
  
  // Video formats (including common video containers)
  const videoExts = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.3gp', '.m4v', '.ts', '.mts'];
  
  // Audio formats
  const audioExts = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.wma'];
  
  // Image formats (will be treated as video content for streaming)
  const imageExts = ['.jpeg', '.jpg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp', '.svg'];
  
  // Check by extension first, then by mimetype
  if (videoExts.includes(ext) || mimetype.startsWith('video/')) {
    return 'video';
  } else if (imageExts.includes(ext) || mimetype.startsWith('image/')) {
    return 'video'; // Images go to video section for streaming
  } else if (audioExts.includes(ext) || mimetype.startsWith('audio/')) {
    return 'audio';
  }
  
  return 'unknown';
}

// Enhanced file type checker for upload validation
function isValidMediaFile(mimetype, filename) {
  const ext = path.extname(filename).toLowerCase();
  
  const validVideoExts = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.3gp', '.m4v', '.ts', '.mts'];
  const validAudioExts = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.wma'];
  const validImageExts = ['.jpeg', '.jpg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp'];
  
  const validExts = [...validVideoExts, ...validAudioExts, ...validImageExts];
  const validMimetypes = ['video/', 'audio/', 'image/'];
  
  const extValid = validExts.includes(ext);
  const mimetypeValid = validMimetypes.some(type => mimetype.startsWith(type));
  
  return extValid && mimetypeValid;
}

// Get detailed file info including media type
function getFileInfo(filePath, filename, mimetype) {
  const stats = fs.statSync(filePath);
  const ext = path.extname(filename).toLowerCase();
  
  let mediaType = 'unknown';
  if (['.jpeg', '.jpg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp'].includes(ext) || mimetype.startsWith('image/')) {
    mediaType = 'image';
  } else if (['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.3gp', '.m4v', '.ts', '.mts'].includes(ext) || mimetype.startsWith('video/')) {
    mediaType = 'video';
  } else if (['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.wma'].includes(ext) || mimetype.startsWith('audio/')) {
    mediaType = 'audio';
  }
  
  return {
    name: filename,
    path: filePath,
    size: stats.size,
    modified: stats.mtime,
    extension: ext,
    mediaType: mediaType,
    type: getFileType(mimetype, filename) // For folder organization
  };
}

// Multer configuration for file uploads with enhanced image support
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const streamId = req.params.streamId || req.body.streamId;
    const fileType = getFileType(file.mimetype, file.originalname);
    const streamDir = path.join(UPLOADS_DIR, streamId);
    const typeDir = path.join(streamDir, fileType === 'video' ? 'video' : 'audio');
    
    console.log('Upload destination:', { 
      streamId, 
      fileType, 
      typeDir, 
      originalName: file.originalname,
      mimetype: file.mimetype 
    });
    
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
    console.log('File filter check:', {
      filename: file.originalname,
      mimetype: file.mimetype,
      extension: path.extname(file.originalname).toLowerCase()
    });
    
    if (isValidMediaFile(file.mimetype, file.originalname)) {
      console.log('File accepted:', file.originalname);
      return cb(null, true);
    } else {
      console.log('File rejected:', file.originalname);
      cb(new Error('Invalid file type! Supported formats: Video (MP4, AVI, MOV, WMV, FLV, WebM, MKV, 3GP), Audio (MP3, WAV, M4A, AAC, OGG, FLAC), Images (JPEG, PNG, GIF, BMP, TIFF, WebP)'));
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
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (['.jpeg', '.jpg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp'].includes(ext)) {
      acc.images = (acc.images || 0) + 1;
    } else if (fileType === 'video') {
      acc.videos = (acc.videos || 0) + 1;
    } else if (fileType === 'audio') {
      acc.audio = (acc.audio || 0) + 1;
    }
    
    return acc;
  }, {});

  console.log('Uploaded files summary:', uploadSummary);
  
  const parts = [];
  if (uploadSummary.videos) parts.push(`${uploadSummary.videos} video${uploadSummary.videos > 1 ? 's' : ''}`);
  if (uploadSummary.images) parts.push(`${uploadSummary.images} image${uploadSummary.images > 1 ? 's' : ''}`);
  if (uploadSummary.audio) parts.push(`${uploadSummary.audio} audio${uploadSummary.audio > 1 ? 's' : ''}`);
  
  const message = `${req.files.length} files uploaded successfully (${parts.join(', ')})`;
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
    
    // Get video files (including images)
    const videoDir = path.join(streamDir, 'video');
    if (fs.existsSync(videoDir)) {
      result.video = fs.readdirSync(videoDir)
        .filter(file => {
          const ext = path.extname(file).toLowerCase();
          // Include all video formats and images
          return [
            // Video formats
            '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.3gp', '.m4v', '.ts', '.mts',
            // Image formats
            '.jpeg', '.jpg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp'
          ].includes(ext);
        })
        .map(file => {
          const filePath = path.join(videoDir, file);
          const stats = fs.statSync(filePath);
          const ext = path.extname(file).toLowerCase();
          
          // Determine if it's an image or video
          const mediaType = ['.jpeg', '.jpg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp'].includes(ext) ? 'image' : 'video';
          
          return {
            name: file,
            path: filePath,
            size: stats.size,
            modified: stats.mtime,
            type: 'video', // Still goes in video section
            mediaType: mediaType, // But we know what it actually is
            extension: ext
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
          return ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.wma'].includes(ext);
        })
        .map(file => {
          const filePath = path.join(audioDir, file);
          const stats = fs.statSync(filePath);
          return {
            name: file,
            path: filePath,
            size: stats.size,
            modified: stats.mtime,
            type: 'audio',
            mediaType: 'audio',
            extension: path.extname(file).toLowerCase()
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
  
  console.log('Starting 1080p stream with enhanced image support:', {
    streamId,
    rtmpUrl: fullRtmpUrl,
    videoCount: files.video.length,
    audioCount: files.audio.length,
    videoFiles: files.video.map(f => ({ name: f.name, mediaType: f.mediaType }))
  });

  // Create playlist files for both video and audio
  const videoPlaylistPath = path.join(STREAMS_DIR, `${streamId}_video_playlist.txt`);
  const audioPlaylistPath = path.join(STREAMS_DIR, `${streamId}_audio_playlist.txt`);

  let ffmpegCommand = ffmpeg();
  let inputIndex = 0;
  
  // Handle video files (including images)
  if (files.video.length > 0) {
    const videoPlaylistContent = files.video.map(file => {
      const escapedPath = file.path.replace(/'/g, "\\'");
      // For images, we'll set a duration (5 seconds per image by default)
      if (file.mediaType === 'image') {
        return `file '${escapedPath}'\nduration 5.0`;
      } else {
        return `file '${escapedPath}'`;
      }
    }).join('\n');
    
    // Add final image duration for proper looping
    const lastFile = files.video[files.video.length - 1];
    if (lastFile.mediaType === 'image') {
      const finalContent = videoPlaylistContent + `\nfile '${lastFile.path.replace(/'/g, "\\'")}'`;
      fs.writeFileSync(videoPlaylistPath, finalContent);
    } else {
      fs.writeFileSync(videoPlaylistPath, videoPlaylistContent);
    }
    
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
    const hasImages = files.video.some(f => f.mediaType === 'image');
    
    if (hasImages) {
      // For images, we need to ensure proper frame rate and add audio
      ffmpegCommand = ffmpegCommand
        .complexFilter([
          '[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30[video]'
        ])
        .map('[video]')
        .inputOptions(['-f lavfi', '-i anullsrc=channel_layout=stereo:sample_rate=44100'])
        .map('1:a');
    } else {
      ffmpegCommand = ffmpegCommand
        .videoFilter('scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2')
        .audioCodec('aac')
        .audioFrequency(44100);
    }
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
  console.log(`🖼️  Enhanced image support: Images will be treated as video content`);
  console.log(`📋 Supported formats:`);
  console.log(`   - Videos: MP4, AVI, MOV, WMV, FLV, WebM, MKV, 3GP, M4V, TS, MTS`);
  console.log(`   - Images: JPEG, PNG, GIF, BMP, TIFF, WebP (5 seconds each)`);
  console.log(`   - Audio: MP3, WAV, M4A, AAC, OGG, FLAC, WMA`);
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