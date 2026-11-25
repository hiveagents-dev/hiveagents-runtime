# Publicar una beta

HiveAgents Runtime se distribuye como un único paquete en npm. La fuente de cada versión se identifica con su commit y su tag. La release de GitHub conserva el artefacto verificado y un recibo revisado para compartir.

## Validación desde un checkout limpio

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run verify:distribution -- --out .artifacts/distribution
```

`verify:distribution` construye un tarball, valida los exports y los enlaces incluidos, e instala esos mismos bytes en una aplicación vacía. La prueba ejecuta un turno determinista y verifica el diagnóstico con `--share`. El recibo identifica la versión, SHA-256, versión de Node, plataforma y resultados sin incluir rutas del equipo.

La CI comprueba macOS con la versión mínima y una versión reciente de Node 22. Linux ejecuta el smoke del paquete. Para extender soporte de cancelación, streaming o permisos a otra plataforma, validá las capacidades específicas antes de anunciarlas. [Matriz de capacidades](capability-matrix.md)

## Corte público y npm

1. Revisá los archivos y sus licencias. Excluí configuraciones privadas, credenciales, registros del equipo y fixtures con datos reales.
2. Elegí un commit con CI verde. Generá un tag `v<versión>` cuyo número coincida con `package.json` y comprobá que la versión está libre en npm.
3. En el paquete de npm, registrá el publicador de GitHub Actions `hiveagents-dev/hiveagents-runtime` con el archivo `npm-release.yml`.
4. Ejecutá **Publish verified beta** sobre el tag. El workflow prueba y publica el mismo tarball con OIDC y procedencia. Verificá la versión bajo `beta`, la atestación y el SHA-256 del artefacto descargado del registro.
5. Publicá el changelog y un enlace a la documentación que corresponde a ese tag.

Los dos flujos de CI usan fixtures sin inferencia comercial. Para validar un proveedor real, guardá versión del CLI, capacidad ejercitada, entorno, cuenta sin identificadores y resultado. Publicá el dato preciso de la prueba. [Compatibilidad](compatibility.md) · [Trusted Publishing de npm](https://docs.npmjs.com/trusted-publishers/)
