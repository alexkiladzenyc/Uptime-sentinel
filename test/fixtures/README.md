Self-signed certificate for `localhost` / `127.0.0.1`, used only by the TLS
tests. It is not a secret. Regenerate with:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout localhost-key.pem -out localhost-cert.pem \
  -days 36500 -subj "/CN=localhost/O=Uptime Sentinel Test" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```
