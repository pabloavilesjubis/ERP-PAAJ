# Firmador (sidecar Java)

Esta carpeta contiene la configuración del **Firmador Electrónico oficial del
MH**. La imagen Docker se descarga del registry público — no necesitas
construir nada.

## Cómo funciona

El servicio `dte-service` invoca al firmador por `http://firmador:8113/firmardocumento/`.
El firmador:

1. Lee el cert `<NIT>.crt` desde `/uploads/` (mapeado a `./firmador/temp/`)
2. Verifica que el `passwordPri` enviado por el cliente coincida con el hash
   SHA-512 almacenado dentro del cert XML
3. Firma el JSON DTE con la llave privada y devuelve un JWS compacto

## El certificado del MH

El MH te entrega un archivo de certificado al activar tu cuenta de facturación
electrónica. **Este archivo NO es un PKCS#12 estándar** — es un formato
propietario en **XML** que sólo el firmador del MH sabe leer.

Estructura interna (verificado contra el código fuente
`svfe-api-firmador/src/main/java/sv/mh/fe/business/CertificadoBusiness.java`):

- El cert es XML deserializable a `CertificadoMH.class`
- Contiene un `privateKey.clave` que es la SHA-512 de tu password
- Cuando llamas al firmador, le mandas el password en plano y él compara
  hashes

## Setup

```bash
mkdir -p firmador/temp
cp /ruta/a/<TU_NIT>.crt firmador/temp/<TU_NIT>.crt
```

Ejemplo:
```
firmador/
  README.md
  temp/
    06140000000000.crt    ← TÚ pones esto (gitignored)
```

La contraseña de la llave privada va en `FIRMADOR_PASSWORD` del `.env` del
servicio Node.

## Por qué el firmador vive aislado

Aislamos el cert + la firma en su propio contenedor por seguridad:

- El `.crt` y su clave privada **nunca tocan** el código Node ni los logs
- Si alguien compromete el contenedor `dte-service`, no obtiene el cert
- El puerto 8113 sólo se publica en `127.0.0.1` — no es accesible desde fuera
- La imagen oficial del MH es la que su portal valida, sin riesgo de
  divergencia de algoritmo

## Verificar que arranca

```bash
docker compose up -d firmador
docker compose logs firmador
# debería ver "Started Application... port 8113"

curl http://localhost:8113/firmardocumento/status
# Application is running...!!
```
