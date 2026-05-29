# Ariana Voice Gateway

Servicio Node.js para:

- Audio a texto con OpenAI (`/api/voice/stt`)
- Texto a audio con OpenAI (`/api/voice/tts`)
- Envio de turnos de voz a Laravel (`/api/voice/turn`)

## Configuracion

Copia `.env.example` a `.env` y completa:

```env
OPENAI_API_KEY=tu_api_key_de_openai
PUBLIC_BASE_URL=http://localhost:3001

# Opcional, recomendado en produccion.
VOICE_API_TOKEN=un_token_largo_y_privado
```

No subas `.env` al repositorio. La API key debe vivir como variable de entorno
en Docker, el servidor o el panel donde despliegues.

## Levantar local

```bash
npm install
npm run dev
```

Health check:

```http
GET http://localhost:3001/api/health
```

## Levantar con Docker

```bash
npm run docker:up
npm run docker:logs
```

## Produccion con Docker

El contenedor escucha internamente en `PORT`, por defecto `3001`. El puerto que
se publica hacia internet se controla con `HOST_PORT`.

Para publicar en el puerto `328`, crea el `.env` del servidor basado en
`.env.production.example`:

```env
NODE_ENV=production
PORT=3001
HOST_PORT=328
PUBLIC_BASE_URL=http://TU_IP_O_DOMINIO:328
OPENAI_API_KEY=tu_api_key_de_openai
VOICE_API_TOKEN=un_token_largo_y_privado
NORMALIZE_MP3_WITH_FFMPEG=true
```

Luego despliega:

```bash
docker compose up -d --build
docker compose logs -f api
```

Prueba:

```http
GET http://TU_IP_O_DOMINIO:328/api/health
```

Si Laravel no corre dentro del mismo contenedor, no uses `LARAVEL_API_URL=http://localhost`
en produccion. Dentro de Docker, `localhost` apunta al contenedor Node.

## Autenticacion interna

Si `VOICE_API_TOKEN` esta definido, envia este header en Insomnia/Laravel:

```http
Authorization: Bearer un_token_largo_y_privado
```

Si `VOICE_API_TOKEN` esta vacio, los endpoints de voz quedan abiertos.

## Insomnia: texto a audio

Metodo:

```http
POST http://localhost:3001/api/voice/tts
```

Headers:

```http
Content-Type: application/json
Authorization: Bearer un_token_largo_y_privado
```

Body JSON:

```json
{
  "text": "Hola, soy Ariana. Esta es una prueba de texto a voz.",
  "voice": "marin",
  "format": "mp3",
  "instructions": "Habla en espanol latino, con tono claro y amable."
}
```

Respuesta esperada:

```json
{
  "ok": true,
  "data": {
    "provider": "openai",
    "audio_url": "http://localhost:3001/api/audio/archivo.mp3"
  }
}
```

Abre `audio_url` para descargar o reproducir el audio.

Cuando el formato es `mp3`, el servicio normaliza el archivo con `ffmpeg` para
que el navegador pueda leer bien la duracion del audio.

## Insomnia: audio a texto

Metodo:

```http
POST http://localhost:3001/api/voice/stt
```

Headers:

```http
Authorization: Bearer un_token_largo_y_privado
```

Body:

- Tipo: `Multipart Form`
- Campo: `audio`
- Tipo de campo: `File`
- Archivo: `.mp3`, `.wav`, `.m4a`, `.webm`, etc.

Campos opcionales:

```text
language=es
prompt=Transcribe esta llamada en espanol.
```

Respuesta esperada:

```json
{
  "ok": true,
  "data": {
    "provider": "openai",
    "model": "gpt-4o-mini-transcribe",
    "text": "Texto transcrito del audio..."
  }
}
```

Tambien puedes enviar JSON con `audio_base64`, `filename` y `mime_type`, pero
para Insomnia normalmente es mas comodo usar `Multipart Form`.

Otra opcion en Insomnia es enviar el archivo como cuerpo binario/raw:

- Body: `File`
- Header: `Content-Type: audio/mpeg` para `.mp3`
- Opcional: `POST /api/voice/stt?language=es`

Si Insomnia muestra que no puede acceder al archivo, permite la carpeta en
`Preferences -> General -> Security` o mueve el archivo a una carpeta permitida.

## Opciones disponibles

```http
GET http://localhost:3001/api/voice/options
```

Devuelve modelos, voces, formatos y limite de subida configurado.

## WhatsApp/Meta WebRTC Calls

El servicio tambien puede crear sesiones WebRTC server-side para llamadas de
WhatsApp/Meta. Laravel recibe el webhook de Meta con `offer_sdp`, llama a este
servicio, recibe `answer_sdp` y luego acepta la llamada en Meta con ese answer.

Endpoint:

```http
POST /api/voice/calls/session
Authorization: Bearer un_token_largo_y_privado
Content-Type: application/json
```

Body:

```json
{
  "call_id": "wamid/HBg...",
  "phone_number_id": "1084473746747071",
  "offer_sdp": "v=0...",
  "tenant": "sigcrm_intelho",
  "agent_id": 1,
  "callback_url": "https://intelho.sigcrm.pro/api/voice-calls/events"
}
```

Respuesta:

```json
{
  "ok": true,
  "data": {
    "session_id": "uuid",
    "answer_sdp": "v=0..."
  }
}
```

Flujo interno:

```text
Meta offer_sdp -> Laravel -> Ariana Voice Gateway
Gateway crea RTCPeerConnection y answer_sdp
Laravel acepta la llamada en Meta con answer_sdp
Gateway captura audio remoto, corta turnos por silencio/RMS y usa STT
Gateway envia transcript a Laravel por callback_url
Laravel responde con text o audio_url
Gateway genera/reproduce TTS hacia la llamada WebRTC
```

Callback de transcripcion hacia Laravel:

```json
{
  "event": "transcript",
  "session_id": "uuid",
  "call_id": "wamid/HBg...",
  "sequence": 1,
  "text": "Hola, quiero agendar una cita",
  "audio_url": "http://sigcenter.ddns.net:328/api/audio/inbound-uuid-1.wav",
  "tenant": "sigcrm_intelho",
  "agent_id": 1
}
```

Respuesta esperada de Laravel:

```json
{
  "ok": true,
  "data": {
    "text": "Claro, dime para que dia deseas la cita."
  }
}
```

Tambien puede responder con `audio_url`; en ese caso el gateway descarga ese
audio y lo reproduce en la llamada.

Cerrar sesion desde Laravel:

```http
POST /api/voice/calls/{session_id}/close
Authorization: Bearer un_token_largo_y_privado
Content-Type: application/json
```

```json
{
  "reason": "meta_terminate"
}
```

Variables relevantes:

```env
WEBRTC_ICE_SERVERS=[]
WEBRTC_ICE_GATHER_TIMEOUT_MS=3000
CALL_AUDIO_LANGUAGE=es
CALL_ALLOW_LANGUAGE_OVERRIDE=false
CALL_STT_TEMPERATURE=0
CALL_STT_PROMPT=Transcribe audio de una llamada de WhatsApp en espanol latino. No traduzcas al ingles. Conserva palabras cortas comunes como hola, donde, vale, gracias, cita y agenda. Si el audio no es claro, devuelve la mejor transcripcion en espanol.
CALL_TURN_RMS_THRESHOLD=0.015
CALL_TURN_SILENCE_MS=900
CALL_TURN_MIN_SPEECH_MS=450
CALL_TURN_MAX_MS=15000
```

Importante para produccion: WebRTC usa ICE/UDP para media, no solo el puerto
HTTP `328`. Si el contenedor esta en Docker bridge y no tienes TURN, Meta puede
recibir el `answer_sdp` pero no lograr conectar media. Para llamadas reales usa
un servidor TURN en `WEBRTC_ICE_SERVERS` o una configuracion Docker/red que
permita candidatos UDP publicos. Las sesiones viven en memoria; si el contenedor
se reinicia, las llamadas activas se pierden.
