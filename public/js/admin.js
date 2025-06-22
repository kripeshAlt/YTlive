// public/js/admin.js (Additional JavaScript for advanced features)
class StreamManager {
    constructor() {
        this.socket = io();
        this.streams = new Map();
        this.init();
    }

    init() {
        this.socket.on('streamStatus', (data) => {
            this.updateStreamStatus(data);
        });

        this.socket.on('streamStats', (data) => {
            this.updateStreamStats(data);
        });
    }

    updateStreamStatus(data) {
        const stream = this.streams.get(data.streamId);
        if (stream) {
            stream.status = data.status;
            this.renderStreamCard(data.streamId);
        }
    }

    updateStreamStats(data) {
        // Update stream statistics like bitrate, fps, etc.
        const statsElement = document.getElementById(`stats-${data.streamId}`);
        if (statsElement) {
            statsElement.innerHTML = `
                <div class="stat-item">
                    <span>Bitrate:</span>
                    <span>${data.bitrate || 'N/A'}</span>
                </div>
                <div class="stat-item">
                    <span>FPS:</span>
                    <span>${data.fps || 'N/A'}</span>
                </div>
                <div class="stat-item">
                    <span>Duration:</span>
                    <span>${this.formatDuration(data.duration)}</span>
                </div>
            `;
        }
    }

    formatDuration(seconds) {
        if (!seconds) return '00:00:00';
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
}

// Initialize stream manager when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new StreamManager();
});

