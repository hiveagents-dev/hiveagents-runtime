# Contribuir a HiveAgents Runtime

Necesitás Node.js 22.16 o posterior y npm. El repositorio de la beta se verifica en macOS. Linux tiene una prueba de instalación y ejecución del paquete.

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run verify:distribution
```

Para reportar un fallo, incluí la versión del SDK y del CLI, el transporte, una entrada sintética y el resultado esperado. Podés adjuntar `npx --no-install hiveagents-runtime doctor --share`. Revisá el contenido que compartís y usá el canal privado para un problema de seguridad.

Agregá una prueba de regresión a los cambios de comportamiento. Si cambia un import público, un permiso efectivo o una capacidad del CLI, actualizá la guía y probá el tarball desde una app vacía. Las suites de CI usan fixtures sin inferencia comercial.

[Issues](https://github.com/hiveagents-dev/hiveagents-runtime/issues) · [Reportar seguridad](SECURITY.md)
