# Thetis On The Web

A single-file browser application that gives you full remote control 
of an Apache Labs ANAN-G2 and other SDR transceivers running Thetis software — 
from any device on your network or the internet.

## Features
- Full VFO A/B control with mouse wheel and touch tuning
- Band, mode, and filter control
- RX audio streaming to browser
- TX audio from browser microphone via TCI
- Real-time audio spectrum and waterfall display
  RX level meter
- Split, NR, Mute, Monitor, Tune
- RX2 
- Antenna selection
- Mobile and tablet responsive
- No install, no dependencies — just open the HTML file

## Requirements
- Thetis v2.10.3.11 or later
- Chrome or Firefox
- Page must be served over HTTPS for microphone access (TX audio)

## Usage
1. Host thetis-on-the-web.html on any HTTPS server (GitHub Pages works great)
2. In Thetis: Setup → Network → TCI Server → tick Server Running
3. Open the page, enter ws://[your-pc-ip]:50001 and click CONNECT

## TCI Protocol
Built on TCI Protocol v2.0 (Expert Electronics).
Tested with Apache Labs ANAN-G2 / Thetis.
