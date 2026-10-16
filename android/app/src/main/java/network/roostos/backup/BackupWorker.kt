package network.roostos.backup

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/**
 * Sends photos and videos Roost doesn't have yet. Runs on the system's schedule
 * (about hourly, on Wi-Fi) and when "Back up now" is pressed. When the Roost
 * server can't be reached (away from home) it quietly stops and tries later.
 */
class BackupWorker(private val context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val prefs = Prefs(context)

    override suspend fun doWork(): Result {
        if (!prefs.signedIn) return Result.success()
        val server = prefs.server
        val key = prefs.key
        var sent = 0
        try {
            val items = MediaScan.find(context, prefs.allFolders)
            val fresh = ArrayList<MediaItem>()
            for (batch in items.chunked(200)) {
                val have = RoostApi.check(server, key, batch.map { it.id })
                batch.filterTo(fresh) { it.id !in have }
            }
            for ((i, item) in fresh.withIndex()) {
                if (isStopped) return Result.retry()
                setForeground(foreground("Backing up ${i + 1} of ${fresh.size}"))
                send(server, key, item)
                sent++
            }
            note(if (sent > 0) "Sent $sent new photos and videos." else "Everything is backed up (${items.size} on this phone).")
            return Result.success()
        } catch (e: RoostApi.ApiError) {
            if (e.status == 401) {
                prefs.signOut()
                note("Signed out. Sign in again to carry on.")
                return Result.failure()
            }
            note("Roost said: ${e.message}")
            return Result.failure()
        } catch (e: SecurityException) {
            note("Allow access to photos and videos, then press Back up now.")
            return Result.failure()
        } catch (e: IOException) {
            // Not at home, out of signal or the server is down: try again on the next run.
            if (e is ConnectException || e is UnknownHostException || e is SocketTimeoutException) {
                if (sent > 0) note("Sent $sent, then lost Roost. It will carry on at home.")
                return Result.success()
            }
            if (sent > 0) note("Sent $sent, then the connection dropped. It will carry on.")
            return Result.retry()
        }
    }

    private suspend fun send(server: String, key: String, item: MediaItem) {
        val up = RoostApi.startUpload(server, key, item.id, item.name, item.size, item.type, item.taken, Build.MODEL ?: "Android phone")
        if (up.have || up.done) return
        var offset = up.received
        var stream = context.contentResolver.openInputStream(item.uri) ?: throw IOException("Can't read ${item.name}")
        try {
            skip(stream, offset)
            while (offset < item.size) {
                if (isStopped) throw IOException("Stopped")
                val len = minOf(up.chunkSize.toLong(), item.size - offset).toInt()
                val (received, done) = RoostApi.putChunk(server, key, up.id, offset, stream, len)
                if (done) return
                if (received != offset + len) {
                    // Roost has a different amount than we sent: carry on from where it is.
                    stream.close()
                    stream = context.contentResolver.openInputStream(item.uri) ?: throw IOException("Can't read ${item.name}")
                    skip(stream, received)
                }
                offset = received
            }
        } finally {
            stream.close()
        }
    }

    private fun skip(s: java.io.InputStream, n: Long) {
        var left = n
        while (left > 0) {
            val skipped = s.skip(left)
            if (skipped <= 0) {
                if (s.read() < 0) throw IOException("The photo changed while it was being sent")
                left--
            } else left -= skipped
        }
    }

    private fun note(text: String) {
        prefs.lastNote = text
        prefs.lastRun = System.currentTimeMillis()
    }

    private fun foreground(text: String): ForegroundInfo {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel("backup", "Backup progress", NotificationManager.IMPORTANCE_LOW))
        val n = NotificationCompat.Builder(context, "backup")
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("Roost Backup")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
        return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else ForegroundInfo(1, n)
    }
}
