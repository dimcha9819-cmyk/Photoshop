@echo off
setlocal enabledelayedexpansion

rem ============================================================
rem  Sort_Photo_Folders.bat
rem  Kladyom fayl v papku s s'yomkoy, zapuskaem dvoynym klikom.
rem    1) sozdaet strukturu papok s numeratsiey
rem    2) *.CR3                      -> "5. RAW"
rem    3) *.JPG/*.JPEG s parnym CR3  -> "4. JPG ORG"
rem  Para ishchetsya TOLKO po imeni (IMG_1234.CR3 <-> IMG_1234.JPG).
rem  Sravnenie po date sm. v versii .ps1
rem ============================================================

set "RAWDIR=5. RAW"
set "JPGDIR=4. JPG ORG"

cd /d "%~dp0"

echo Working folder: %CD%
echo.

rem --- 1. Papki ---
for %%F in ("1. JPG EDITED" "2. PSD" "3. RAW TO EDIT" "4. JPG ORG" "5. RAW" "6. COLLAGE") do (
    if not exist "%%~F\" (
        mkdir "%%~F"
        echo   [+] created: %%~F
    ) else (
        echo   [=] exists : %%~F
    )
)

echo.

rem --- 2. CR3 -> RAW ---
set /a movedraw=0
for %%f in (*.cr3) do (
    if exist "!RAWDIR!\%%~nxf" (
        echo   [!] already in RAW, skipped: %%~nxf
    ) else (
        move "%%f" "!RAWDIR!\" >nul
        if errorlevel 1 (
            echo   [x] move failed: %%~nxf
        ) else (
            set /a movedraw+=1
            echo   -^> %%~nxf  =^>  !RAWDIR!
        )
    )
)

rem --- 3. Parnye JPG -> JPG ORG ---
set /a movedjpg=0
set /a unpaired=0
for %%f in (*.jpg *.jpeg) do (
    if exist "!RAWDIR!\%%~nf.cr3" (
        if exist "!JPGDIR!\%%~nxf" (
            echo   [!] already in JPG ORG, skipped: %%~nxf
        ) else (
            move "%%f" "!JPGDIR!\" >nul
            if errorlevel 1 (
                echo   [x] move failed: %%~nxf
            ) else (
                set /a movedjpg+=1
                echo   -^> %%~nxf  =^>  !JPGDIR!
            )
        )
    ) else (
        set /a unpaired+=1
    )
)

echo.
echo Done.  RAW: !movedraw!   JPG ORG: !movedjpg!   unpaired JPG left in root: !unpaired!

endlocal
exit
