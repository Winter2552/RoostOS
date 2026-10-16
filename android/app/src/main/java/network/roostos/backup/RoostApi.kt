package network.roostos.backup

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/** Talks to Roost with plain HTTP. See "Automatic phone backup" in the README. */
object RoostApi {
    class ApiError(val status: Int, message: String) : IOException(message)

    class Upload(val id: String, val chunkSize: Int, val received: Long, val done: Boolean, val have: Boolean)

    fun cleanAddress(raw: String): String {
        var s = raw.trim().trimEnd('/')
        if (s.isNotEmpty() && !s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
        return s
    }

    private fun open(server: String, path: String, method: String, key: String?): HttpURLConnection {
        val c = URL(server + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 10_000
        c.readTimeout = 60_000
        if (!key.isNullOrEmpty()) c.setRequestProperty("Authorization", "Bearer $key")
        return c
    }

    private fun readBody(c: HttpURLConnection): JSONObject {
        val stream = if (c.responseCode < 400) c.inputStream else c.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
        return try { JSONObject(text.ifEmpty { "{}" }) } catch (e: Exception) { JSONObject() }
    }

    private fun postJson(server: String, path: String, key: String?, body: JSONObject): JSONObject {
        val c = open(server, path, "POST", key)
        try {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toString().toByteArray()) }
            val out = readBody(c)
            if (c.responseCode >= 400) throw ApiError(c.responseCode, out.optString("error", "Error ${c.responseCode}"))
            return out
        } finally {
            c.disconnect()
        }
    }

    /** Returns the device key, or the ticket for the two-step code ("ticket:..."). */
    fun login(server: String, username: String, password: String, device: String): String {
        val out = postJson(server, "/api/login", null, JSONObject().put("username", username).put("password", password).put("device", device))
        if (out.optBoolean("twoStep")) return "ticket:" + out.getString("ticket")
        return out.getString("key")
    }

    fun loginCode(server: String, ticket: String, code: String): String {
        val out = postJson(server, "/api/login/code", null, JSONObject().put("ticket", ticket).put("code", code))
        return out.getString("key")
    }

    /** Which of these photo ids Roost already has. */
    fun check(server: String, key: String, ids: List<String>): Set<String> {
        val items = JSONArray()
        for (id in ids) items.put(JSONObject().put("id", id))
        val out = postJson(server, "/api/backup/check", key, JSONObject().put("items", items))
        val have = out.optJSONArray("have") ?: JSONArray()
        return (0 until have.length()).map { have.getString(it) }.toSet()
    }

    fun startUpload(server: String, key: String, id: String, name: String, size: Long, type: String, taken: Long, device: String): Upload {
        val out = postJson(
            server, "/api/backup/uploads", key,
            JSONObject().put("id", id).put("device", device).put("name", name).put("size", size).put("type", type).put("taken", taken),
        )
        return Upload(out.optString("id"), out.optInt("chunkSize", 0), out.optLong("received", 0), out.optBoolean("done"), out.optBoolean("have"))
    }

    /** Sends one piece. Returns how many bytes Roost now has and whether the file is complete. */
    fun putChunk(server: String, key: String, uploadId: String, offset: Long, data: InputStream, length: Int): Pair<Long, Boolean> {
        val c = open(server, "/api/backup/uploads/$uploadId?offset=$offset", "PUT", key)
        try {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/octet-stream")
            c.setFixedLengthStreamingMode(length)
            c.outputStream.use { out ->
                val buf = ByteArray(64 * 1024)
                var left = length
                while (left > 0) {
                    val n = data.read(buf, 0, minOf(buf.size, left))
                    if (n < 0) throw IOException("The photo changed while it was being sent")
                    out.write(buf, 0, n)
                    left -= n
                }
            }
            val body = readBody(c)
            // 409 means Roost has a different amount than we thought; it says how much.
            if (c.responseCode >= 400 && c.responseCode != 409) throw ApiError(c.responseCode, body.optString("error", "Error ${c.responseCode}"))
            return Pair(body.optLong("received", offset), body.optBoolean("done"))
        } finally {
            c.disconnect()
        }
    }
}
