package network.roostos.backup

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.MediaStore

class MediaItem(val uri: Uri, val id: String, val name: String, val size: Long, val type: String, val taken: Long)

/** Finds the photos and videos on the phone, newest first. */
object MediaScan {
    // The column is called this on every Android version; the named constant needs Android 10.
    private const val DATE_TAKEN = "datetaken"

    fun find(context: Context, allFolders: Boolean): List<MediaItem> {
        val out = ArrayList<MediaItem>()
        scan(context, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, allFolders, out)
        scan(context, MediaStore.Video.Media.EXTERNAL_CONTENT_URI, allFolders, out)
        out.sortByDescending { it.taken }
        return out
    }

    private fun scan(context: Context, collection: Uri, allFolders: Boolean, out: MutableList<MediaItem>) {
        val columns = arrayOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.MIME_TYPE,
            DATE_TAKEN,
            MediaStore.MediaColumns.DATE_ADDED,
        )
        val where = ArrayList<String>()
        val args = ArrayList<String>()
        where.add("${MediaStore.MediaColumns.SIZE} > 0")
        if (Build.VERSION.SDK_INT >= 29) {
            // Skip files the camera is still writing.
            where.add("${MediaStore.MediaColumns.IS_PENDING} = 0")
            if (!allFolders) {
                where.add("${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?")
                args.add("DCIM/%")
            }
        }
        context.contentResolver.query(collection, columns, where.joinToString(" AND "), args.toTypedArray(), null)?.use { c ->
            val idCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
            val nameCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
            val sizeCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
            val typeCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.MIME_TYPE)
            val takenCol = c.getColumnIndexOrThrow(DATE_TAKEN)
            val addedCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_ADDED)
            while (c.moveToNext()) {
                val name = c.getString(nameCol) ?: continue
                val size = c.getLong(sizeCol)
                val taken = c.getLong(takenCol).takeIf { it > 0 } ?: (c.getLong(addedCol) * 1000)
                // Stays the same for the same photo, so Roost can tell it has it already.
                out.add(MediaItem(ContentUris.withAppendedId(collection, c.getLong(idCol)), "$name|$size|$taken", name, size, c.getString(typeCol) ?: "", taken))
            }
        }
    }
}
