# Roost Backup (Android)

A small app that sends your phone's new photos and videos to your own Roost, like Google Photos backup. It signs in once, then runs by itself about every hour on Wi-Fi (and when you press **Back up now**). Photos land in Glint under `Photos/<year>`; ones Roost already has are skipped, and big videos upload in resumable pieces.

## Install

1. In GitHub, open the **Android app** run for the latest commit (Actions tab) and download the `roost-backup-apk` artifact. Unzip it to get `app-debug.apk`.
2. On the phone, open the APK and allow installing from that source when asked.
3. Open Roost Backup, enter Roost's address (e.g. `192.168.1.20:8080`), your username and password (and the two-step code if asked), then allow access to photos and videos.

It only sends over Wi-Fi by default and only the camera folder; both are switches on the main screen. At home it reaches Roost on the home address; away from home it stays quiet and carries on when you are back.

## How it works

Plain Android with one dependency, WorkManager (the system scheduler). It talks to Roost's backup API (see "Automatic phone backup" in the main README) with a device key from `POST /api/login`, so it never stores your password. Signing out forgets the key.

Build locally with Android Studio, or `gradle -p android assembleDebug` with the Android SDK installed.
