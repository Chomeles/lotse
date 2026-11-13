@echo off
rem Baut mit Vulkan: MSVC-Umgebung, Ninja statt MSBuild und ein kurzer Bauordner (Pfadlimit von Windows).
rem Aufruf: build.cmd cargo tauri build   (oder jeder andere cargo-Befehl)
if not defined VULKAN_SDK echo VULKAN_SDK fehlt: winget install KhronosGroup.VulkanSDK & exit /b 1
call "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
set PATH=%VULKAN_SDK%\Bin;%PATH%
set CARGO_TARGET_DIR=C:\ht
set CMAKE_GENERATOR=Ninja
cd /d "%~dp0"
%*
