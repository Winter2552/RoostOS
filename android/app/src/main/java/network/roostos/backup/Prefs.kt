package network.roostos.backup

import android.content.Context

/** The few things the app remembers. Kept in the app's private storage. */
class Prefs(context: Context) {
    private val p = context.applicationContext.getSharedPreferences("roost", Context.MODE_PRIVATE)

    var server: String
        get() = p.getString("server", "") ?: ""
        set(v) = p.edit().putString("server", v).apply()

    var key: String
        get() = p.getString("key", "") ?: ""
        set(v) = p.edit().putString("key", v).apply()

    var username: String
        get() = p.getString("username", "") ?: ""
        set(v) = p.edit().putString("username", v).apply()

    var allFolders: Boolean
        get() = p.getBoolean("allFolders", false)
        set(v) = p.edit().putBoolean("allFolders", v).apply()

    var wifiOnly: Boolean
        get() = p.getBoolean("wifiOnly", true)
        set(v) = p.edit().putBoolean("wifiOnly", v).apply()

    /** What the last run did, shown on the main screen. */
    var lastNote: String
        get() = p.getString("lastNote", "") ?: ""
        set(v) = p.edit().putString("lastNote", v).apply()

    var lastRun: Long
        get() = p.getLong("lastRun", 0L)
        set(v) = p.edit().putLong("lastRun", v).apply()

    val signedIn: Boolean get() = server.isNotEmpty() && key.isNotEmpty()

    fun signOut() {
        p.edit().remove("key").remove("lastNote").remove("lastRun").apply()
    }
}
