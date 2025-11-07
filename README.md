# GPS Tracker Server

Servidor TCP para recibir conexiones de dispositivos GPS tracker y administrarlos mediante endpoints HTTP.

## Características

- ✅ Acepta conexiones TCP de dispositivos GPS
- ✅ Responde automáticamente a comandos LK (Link Keep) para mantener la conexión
- ✅ Guarda IMEI y estado de conexión en MongoDB
- ✅ Endpoint HTTP para cambiar el servidor del GPS
- ✅ Endpoint HTTP para verificar configuración con comando TS

## Instalación

1. Instalar dependencias:
```bash
npm install
```

2. Configurar variables de entorno (crear archivo `.env`):
```
MONGO_URI=mongodb://localhost:27017/gps_tracker
TCP_PORT=6808
HTTP_PORT=3000
HOST=0.0.0.0
```

3. Asegurarse de que MongoDB esté corriendo

## Uso

### Iniciar el servidor

```bash
npm start
```

O en modo desarrollo con auto-reload:
```bash
npm run dev
```

### Endpoints HTTP

#### Health Check
```bash
GET http://localhost:3000/health
```

#### Cambiar servidor del GPS
```bash
POST http://localhost:3000/change-server
Content-Type: application/json

{
  "imei": "351258730074555",
  "newIp": "148.230.83.171",
  "newPort": "6808"
}
```

**Nota importante**: El dispositivo debe estar conectado a este servidor para poder cambiar la configuración. Si el GPS está aún en el servidor oficial, deberás contactar al proveedor para hacer FOTA.

#### Verificar configuración (comando TS)
```bash
POST http://localhost:3000/send-ts
Content-Type: application/json

{
  "imei": "351258730074555"
}
```

## Protocolo

El servidor maneja mensajes en formato:
```
[3G*IMEI*LEN*BODY]
```

- **LK**: Link Keep - El servidor responde automáticamente
- **IP**: Cambio de servidor - Se envía desde el endpoint `/change-server`
- **TS**: Verificación de estado - Se envía desde el endpoint `/send-ts`

## Cálculo de LEN

El campo LEN es la longitud del payload en 4 dígitos con ceros a la izquierda.

Ejemplo:
- Payload: `IP,148.230.83.171,6808` → Longitud: 22 → LEN: `0022`
- Payload: `IP,1.2.3.4,9000` → Longitud: 14 → LEN: `0014`

## Notas Importantes

1. **Firewall**: Asegúrate de que el puerto TCP (por defecto 6808) esté abierto en el firewall
2. **MongoDB**: El servidor necesita conexión a MongoDB para guardar los IMEI
3. **Conexión persistente**: El servidor mantiene conexiones TCP persistentes (no cierra después de LK)
4. **Reinicio del dispositivo**: Después de cambiar el servidor, reinicia el GPS físicamente y espera 6-8 minutos

## Pruebas

Puedes simular un GPS con netcat:
```bash
nc <YOUR_SERVER_IP> 6808
```

Luego envía un mensaje de prueba:
```
[3G*351258730074555*0009*LK,0,0,21]
```

El servidor debería responder con:
```
[3G*351258730074555*0002*LK]
```

