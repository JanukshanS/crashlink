# esp32-cam (PlatformIO)

Scaffold only. Per §5.3.11 and Appendix E.1.1: softAP, `GET /capture` returning
`image/jpeg` with `X-SHA256` and `Content-Length`, plus `GET /health`.

Proven settings: QVGA, `jpeg_quality = 20`, `fb_count = 1`, ~4 KB frames.
Keep it there - §E.1.5 caps uploads at 10 KB.
