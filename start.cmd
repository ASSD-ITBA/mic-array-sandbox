@echo off
rem Mic array sandbox: doble clic aca.
rem
rem index.html no se puede abrir con doble clic: los navegadores bloquean Web
rem Workers y WebAssembly en file://, y Python no arrancaría. Esto sirve la
rem carpeta en http://localhost y la abre en el navegador (Chrome o Edge, por
rem Web Serial).

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" %*

if errorlevel 1 pause
