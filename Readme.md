// README.md
  # Live Streaming Server
  
  A professional live streaming server built with Node.js, Express, EJS, and FFmpeg that allows you to create and manage multiple streaming channels with playlist functionality.
  
  ## Features
  
  - **Multi-Stream Management**: Create and manage multiple streaming channels
  - **File Upload**: Upload video and audio files for each stream
  - **Playlist Streaming**: Automatically loop through multiple media files
  - **Real-time Controls**: Start, stop, and restart streams with live status updates
  - **YouTube Integration**: Direct streaming to YouTube Live and other RTMP servers
  - **Professional UI**: Modern, responsive web interface
  - **File Management**: Upload, view, and delete media files
  - **Real-time Status**: Live updates using WebSocket connections
  
  ## Prerequisites
  
  - Node.js (v14 or higher)
  - FFmpeg installed on your system
  - RTMP server access (YouTube Live, Twitch, etc.)
  
  ## Installation
  
  1. Clone or download the project files
  2. Install dependencies:
     ```bash
     npm install
     ```
  
  3. Install FFmpeg:
     - **Windows**: Download from https://ffmpeg.org/download.html
     - **macOS**: `brew install ffmpeg`
     - **Linux**: `sudo apt-get install ffmpeg`
  
  4. Start the server:
     ```bash
     npm start
     ```
  
  5. Open your browser and navigate to `http://localhost:3000`
  
  ## Usage
  
  ### Creating a Stream
  
  1. Go to the homepage
  2. Enter a unique Stream ID
  3. Click "Create Stream"
  
  ### Uploading Media Files
  
  1. Navigate to your stream page
  2. Use the upload area to select video/audio files
  3. Supported formats: MP4, MP3, WAV, AVI, MOV, WMV, FLV, WebM, M4A, AAC
  
  ### Starting a Stream
  
  1. Enter your RTMP server URL (e.g., `rtmp://a.rtmp.youtube.com/live2`)
  2. Enter your stream key from your streaming platform
  3. Click "Start Stream"
  
  The system will automatically:
  - Create a playlist from your uploaded files
  - Loop through all files continuously
  - Stream to your specified RTMP endpoint
  
  ### Stream Controls
  
  - **Start**: Begin streaming with the current playlist
  - **Stop**: Stop the current stream
  - **Restart**: Stop and restart the stream with updated settings
  
  ## Configuration
  
  ### YouTube Live Setup
  
  1. Go to YouTube Studio
  2. Navigate to "Go Live"
  3. Copy your Stream Key
  4. Use RTMP URL: `rtmp://a.rtmp.youtube.com/live2`
  
  ### Twitch Setup
  
  1. Go to Twitch Creator Dashboard
  2. Navigate to Settings > Stream
  3. Copy your Primary Stream Key
  4. Use RTMP URL: `rtmp://live.twitch.tv/live`
  
  ## File Structure
  
  ```
  ├── server.js              # Main server file
  ├── package.json           # Dependencies and scripts
  ├── views/
  │   ├── layout.ejs         # Main layout template
  │   ├── index.ejs          # Homepage
  │   └── stream.ejs         # Stream management page
  ├── uploads/               # Uploaded media files (auto-created)
  ├── streams/               # Temporary streaming files (auto-created)
  └── public/
      └── js/
          └── admin.js       # Additional client-side features
  ```
  
  ## API Endpoints
  
  - `GET /` - Homepage with stream list
  - `GET /stream/:streamId` - Stream management page
  - `POST /create-stream` - Create new stream
  - `POST /upload/:streamId` - Upload files to stream
  - `POST /start-stream/:streamId` - Start streaming
  - `POST /stop-stream/:streamId` - Stop streaming
  - `POST /restart-stream/:streamId` - Restart streaming
  - `DELETE /delete-file/:streamId/:filename` - Delete file
  
  ## Technical Details
  
  ### FFmpeg Configuration
  
  The application uses optimized FFmpeg settings for live streaming:
  - Video: H.264 codec, 1280x720 resolution, 2500k bitrate
  - Audio: AAC codec, 128k bitrate, 44100Hz sample rate
  - Format: FLV for RTMP compatibility
  - Preset: veryfast for low latency
  
  ### Real-time Updates
  
  Uses Socket.IO for real-time communication between server and clients:
  - Stream status updates
  - Error notifications
  - Statistics tracking
  
  ## Troubleshooting
  
  ### Common Issues
  
  1. **FFmpeg not found**: Ensure FFmpeg is installed and in your system PATH
  2. **Stream not starting**: Check RTMP URL and stream key
  3. **Files not uploading**: Verify file formats are supported
  4. **Connection issues**: Ensure firewall allows the application port
  
  ### Logs
  
  Check server console for detailed error messages and streaming status.
  
  ## Development
  
  To run in development mode with auto-restart:
  ```bash
  npm run dev
  ```
  
  ## License
  
  This project is open source and available under the MIT License.
  
  ## Support
  
  For issues and questions, please check the troubleshooting section or create an issue in the project repository.