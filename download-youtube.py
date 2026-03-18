# /// script
# requires-python = ">=3.12"
# dependencies = ["yt-dlp"]
# ///

import yt_dlp

ydl_opts = {
    "format": "bestaudio/best",
    "postprocessors": [
        {
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        },
    ],
    "outtmpl": "%(title)s.%(ext)s",
}

with yt_dlp.YoutubeDL(ydl_opts) as ydl:
    ydl.download(["YOUTUBE_LINK"])
