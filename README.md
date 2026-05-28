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
