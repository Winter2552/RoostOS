package network.roostos.backup

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.text.format.DateUtils
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** One screen: sign in to Roost once, then it backs up on its own. */
class MainActivity : Activity() {
    private lateinit var prefs: Prefs
    private var ticket = ""

    private val signInBox by lazy { findViewById<LinearLayout>(R.id.signInBox) }
    private val readyBox by lazy { findViewById<LinearLayout>(R.id.readyBox) }
    private val message by lazy { findViewById<TextView>(R.id.message) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)

        findViewById<EditText>(R.id.server).setText(prefs.server)
        findViewById<EditText>(R.id.username).setText(prefs.username)
        findViewById<Button>(R.id.signIn).setOnClickListener { signIn() }
        findViewById<Button>(R.id.backupNow).setOnClickListener { backupNow() }
        findViewById<Button>(R.id.signOut).setOnClickListener {
            WorkManager.getInstance(this).cancelUniqueWork("periodic")
            prefs.signOut()
            show()
        }
        findViewById<CheckBox>(R.id.allFolders).setOnCheckedChangeListener { _, on -> prefs.allFolders = on }
        findViewById<CheckBox>(R.id.wifiOnly).setOnCheckedChangeListener { _, on -> prefs.wifiOnly = on; schedule() }
        show()
    }

    override fun onResume() {
        super.onResume()
        show()
    }

    private fun show() {
        val ready = prefs.signedIn
        signInBox.visibility = if (ready) View.GONE else View.VISIBLE
        readyBox.visibility = if (ready) View.VISIBLE else View.GONE
        if (!ready) return
        findViewById<TextView>(R.id.who).text = "Signed in as ${prefs.username} on ${prefs.server}"
        findViewById<CheckBox>(R.id.allFolders).isChecked = prefs.allFolders
        findViewById<CheckBox>(R.id.wifiOnly).isChecked = prefs.wifiOnly
        val last = if (prefs.lastRun > 0) {
            "${prefs.lastNote}\n${DateUtils.getRelativeTimeSpanString(prefs.lastRun, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS)}"
        } else "Waiting for the first backup. It runs by itself about once an hour."
        findViewById<TextView>(R.id.status).text = last
    }

    private fun say(text: String) {
        message.text = text
    }

    private fun signIn() {
        val server = RoostApi.cleanAddress(findViewById<EditText>(R.id.server).text.toString())
        val username = findViewById<EditText>(R.id.username).text.toString().trim()
        val password = findViewById<EditText>(R.id.password).text.toString()
        val code = findViewById<EditText>(R.id.code).text.toString().trim()
        if (server.isEmpty() || username.isEmpty() || password.isEmpty()) return say("Fill in the address, username and password.")
        say("Signing in…")
        thread {
            try {
                val result = if (ticket.isNotEmpty() && code.isNotEmpty()) RoostApi.loginCode(server, ticket, code)
                else RoostApi.login(server, username, password, Build.MODEL ?: "Android phone")
                runOnUiThread {
                    if (result.startsWith("ticket:")) {
                        ticket = result.removePrefix("ticket:")
                        findViewById<EditText>(R.id.code).visibility = View.VISIBLE
                        say("Enter the code from your authenticator app, then press Sign in again.")
                    } else {
                        prefs.server = server
                        prefs.username = username
                        prefs.key = result
                        ticket = ""
                        findViewById<EditText>(R.id.password).setText("")
                        say("")
                        askPermissions()
                        schedule()
                        show()
                    }
                }
            } catch (e: RoostApi.ApiError) {
                runOnUiThread { say(e.message ?: "Could not sign in") }
            } catch (e: Exception) {
                runOnUiThread { say("Can't reach Roost at that address. Are you on your home Wi-Fi?") }
            }
        }
    }

    private fun askPermissions() {
        val wanted = ArrayList<String>()
        if (Build.VERSION.SDK_INT >= 33) {
            wanted += Manifest.permission.READ_MEDIA_IMAGES
            wanted += Manifest.permission.READ_MEDIA_VIDEO
            wanted += Manifest.permission.POST_NOTIFICATIONS
        } else {
            wanted += Manifest.permission.READ_EXTERNAL_STORAGE
        }
        if (Build.VERSION.SDK_INT >= 29) wanted += Manifest.permission.ACCESS_MEDIA_LOCATION
        val missing = wanted.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), 1)
    }

    private fun constraints(): Constraints = Constraints.Builder()
        .setRequiredNetworkType(if (prefs.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
        .setRequiresBatteryNotLow(true)
        .build()

    /** The system runs the backup about hourly, on Wi-Fi, and skips it when the battery is low. */
    private fun schedule() {
        if (!prefs.signedIn) return
        val req = PeriodicWorkRequestBuilder<BackupWorker>(1, TimeUnit.HOURS).setConstraints(constraints()).build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork("periodic", ExistingPeriodicWorkPolicy.UPDATE, req)
    }

    private fun backupNow() {
        askPermissions()
        val req = OneTimeWorkRequestBuilder<BackupWorker>().setConstraints(constraints()).build()
        WorkManager.getInstance(this).enqueueUniqueWork("now", ExistingWorkPolicy.REPLACE, req)
        say("Started. It runs once Wi-Fi is connected; watch the notification.")
    }
}
