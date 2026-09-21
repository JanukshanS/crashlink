// Copy to network.h (gitignored) and fill in. Selects how the bike reaches the API.
#pragma once

#define CL_TRANSPORT_WIFI 1  // dev: Wi-Fi to a laptop on the same network
#define CL_TRANSPORT_GPRS 2  // demo/production: SIM800L GPRS to the public server

#define CL_TRANSPORT CL_TRANSPORT_GPRS

// Used only with CL_TRANSPORT_WIFI.
#define CL_WIFI_SSID     "your-wifi"
#define CL_WIFI_PASSWORD "your-password"

// Base URL of the API. The SIM800L speaks plain HTTP (AT+HTTPSSL=0), so for
// GPRS this is the server's http:// address; nginx serves /d/ on port 80.
#define CL_API_BASE "http://203.0.113.10"

#define CL_APN "dialogbb"  // Dialog; proven in Appendix E.1.1
