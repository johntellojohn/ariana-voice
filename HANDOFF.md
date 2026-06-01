# Handoff

Fecha: 2026-06-01
Zona horaria del usuario: America/Guayaquil

## Contexto General

El usuario estaba trabajando en una migracion incremental de una vista productiva de workflow builder en Laravel/Livewire. La vista original funciona en produccion, pero es lenta porque contiene demasiada logica y modales dentro del mismo Blade.

El objetivo principal era crear y evolucionar una nueva ruta:

- `/automation-ver-new/{automationId}`

La migracion debe hacerse por partes, sin romper la ruta productiva actual.

## Proyecto Original De La Migracion

El trabajo de migracion ocurria en:

- `C:\laragon\www\eva`

Archivos originales relevantes:

- `resources/views/livewire/automation-ver/automation-ver-component.blade.php`
- `app/Livewire/AutomationVer/AutomationVerComponent.php`
- `public/assets/js/drawflow.js`

Archivos nuevos ya creados en esa conversacion:

- `app/Livewire/AutomationVer/AutomationVerNewComponent.php`
- `resources/views/livewire/automation-ver-new/automation-ver-new-component.blade.php`
- `public/assets/css/automation-ver-new.css`
- `public/assets/js/automation-ver-new.js`

Tambien se habia quitado la logica de expiracion/bloqueo del `mount()` de `AutomationVerNewComponent`, porque el usuario no queria migrar esa parte.

## Estado De La Vista Nueva

La nueva vista `/automation-ver-new` ya existe y tiene un diseno light moderno que el usuario aprobo despues de varios ajustes. El usuario fue claro en que ese estilo aprobado debe mantenerse a partir de ahora.

Se corrigieron problemas de modales:

- El modal quedaba detras o cruzado con bloques del canvas.
- Los modales eran demasiado delgados.
- Se ajusto `z-index`, ancho, overlay y bloqueo de interaccion con el canvas mientras el modal esta abierto.

Archivos tocados para esa parte:

- `public/assets/css/automation-ver-new.css`
- `public/assets/js/automation-ver-new.js`
- `resources/views/livewire/automation-ver-new/modals/bloque-edicion-texto-modal-component.blade.php`
- `resources/views/livewire/automation-ver-new/partials/general-settings-modal.blade.php`

## Modales De Bloques

Primer modal separado correctamente:

- `app/Livewire/AutomationVer/Modals/BloqueEdicionTextoModalComponent.php`
- `resources/views/livewire/automation-ver-new/modals/bloque-edicion-texto-modal-component.blade.php`

Ese modal es el patron correcto: componente aparte, llamado desde la ruta nueva, sin meter todo en la vista principal.

## Punto Critico Pendiente

Hubo una implementacion intermedia incorrecta respecto a los modales:

- Se creo `resources/views/livewire/automation-ver-new/partials/legacy-block-modals.blade.php`.
- Se cargo condicionalmente con `$legacyBlockModalsLoaded`.
- Se agregaron wrappers en `AutomationVerNewComponent.php` para abrir modales legacy.

El usuario rechazo esa direccion. Su instruccion fue clara:

- Nada de `legacy`.
- Todos los modales de bloques deben migrarse a componentes separados.
- Deben llamarse solo cuando el usuario presione el boton correspondiente.
- No quiere volver a inflar la vista principal.

Si se retoma esta tarea, hay que corregir el rumbo:

1. Reconocer que la extraccion legacy no era el destino correcto.
2. Remover o dejar de usar `legacy-block-modals.blade.php`.
3. Migrar modal por modal a componentes Livewire dedicados.
4. Mantener la vista nueva ligera.
5. Mantener el diseno light aprobado.

Componentes Livewire de modales que ya existian y pueden reutilizarse:

- `app/Livewire/AutomationVer/Modals/AutomationVerModalConectarVariables.php`
- `app/Livewire/AutomationVer/Modals/BloqueEmbudoComponent.php`
- `app/Livewire/AutomationVer/Modals/BloqueEnvioInformesComponent.php`
- `app/Livewire/AutomationVer/Modals/GuardarConversacionComponent.php`
- `app/Livewire/AutomationVer/Modals/BloqueEdicionTextoModalComponent.php`

Siguiente enfoque recomendado:

- Empezar por un lote pequeno de modales de bloque con alto uso.
- Prioridad probable: `Archivo`, `Email`, `Pago`, `GPT`, `JSON`, `Respuesta`.
- Para cada uno: extraer logica, crear componente, conectar evento de apertura, renderizar solo cuando se use, validar guardado y refresco del canvas.

## Validaciones Ejecutadas En La Migracion

En la conversacion anterior se validaron correctamente:

- `php -l app/Livewire/AutomationVer/AutomationVerNewComponent.php`
- `node --check public/assets/js/automation-ver-new.js`
- `php artisan view:cache`

## Incidente De Seguridad En Produccion

El usuario tambien estaba revisando logs de Nginx de produccion porque el servidor se cayo aproximadamente entre `12:45` y `13:00` del `24/Apr/2026`.

Logs vistos:

- `/var/log/nginx/access.log`
- posibles error logs:
  - `base.sigcrm.pro-error.log`
  - `sigcrm.pro-error.log`
  - `ws.sigcrm.pro-error.log`
  - `error.log`

Analisis previo:

- Se vio escaneo automatizado sostenido desde temprano.
- Muchas peticiones a rutas tipicas de ataques oportunistas:
  - `/.env`
  - `/.git/HEAD`
  - `.vscode/sftp.json`
  - `sftp.json`
  - `wp-*`
  - `wp-content/*`
  - `shell.php`
  - `admin.php`
  - `xxx.php`
  - `inputs.php`
  - `/cgi-bin/.../bin/sh`
- La mayoria respondian `301 162`.
- Eso sugiere redireccion uniforme HTTP -> HTTPS o host canonico, no ejecucion exitosa.
- No se vio evidencia directa en ese fragmento de compromiso exitoso ni DDoS volumetrico.
- Para confirmar causa de caida faltaba revisar:
  - access log de HTTPS
  - error log entre `12:40` y `13:10`
  - logs de `php-fpm`
  - logs de MySQL
  - `dmesg` o `journalctl -k` buscando OOM killer

Archivos correctos para evento de hoy:

- `access.log`
- `base.sigcrm.pro-error.log` si cayo `base.sigcrm.pro`
- `sigcrm.pro-error.log` si cayo `sigcrm.pro`
- `ws.sigcrm.pro-error.log` si cayo websocket
- `error.log` como apoyo global de Nginx

No empezar por:

- `access.log.1`
- `*.gz`
- `*-error.log.1`

porque son logs rotados de dias anteriores o de ayer.

## Proteccion Recomendada Para El Servidor

Prioridad inmediata:

1. Poner Cloudflare o WAF delante del servidor.
2. Confirmar que HTTP -> HTTPS lo resuelve Nginx, no Laravel/PHP.
3. Bloquear rutas sensibles en Nginx:
   - `/.env`
   - `/.git`
   - `/.vscode`
   - `sftp*.json`
   - `wp-*` si no usa WordPress
4. Bloquear ejecucion directa de cualquier `.php` excepto `index.php`.
5. Activar `limit_req` y `limit_conn`.
6. Instalar/configurar `fail2ban`.
7. Revisar hardening de SSH, firewall y backups.

Ejemplo base sugerido:

```nginx
location ~ /\.(env|git|ht|svn) {
    deny all;
    return 444;
}

location ~* ^/(?:\.vscode|vendor|storage|backup|backups)/ {
    deny all;
    return 444;
}

location ~* ^/(?:sftp|sftp-config)\.json$ {
    deny all;
    return 444;
}

location ~* ^/(?:wp-admin|wp-content|wp-includes|xmlrpc\.php|wp-login\.php|wordpress|wp-).*$ {
    return 444;
}
```

Para Laravel se sugirio revisar cuidadosamente el bloque PHP para permitir solo `index.php`, ajustando el socket PHP real del servidor:

```nginx
location ~ \.php$ {
    if ($uri !~ "^/index\.php$") {
        return 444;
    }

    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
    fastcgi_pass unix:/run/php/php8.2-fpm.sock;
}
```

## Proyecto Actual

La raiz actual del entorno al crear este handoff es:

- `C:\laragon\www\ariana-voice`

Este handoff se creo en esa raiz porque el usuario lo pidio explicitamente ahi.

