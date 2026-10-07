package app.oraychat.mobile;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSExport;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * 分布式自动更新（M3，Android 辅助模式）：filex 把 APK 下载到 WebView 沙箱后，
 * 经此插件调起系统安装器一键安装。系统安全边界：安装必须用户确认，无法静默。
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {

    @PluginMethod
    public void installApk(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("缺少 APK 路径");
            return;
        }
        Activity activity = getActivity();
        if (activity == null) { call.reject("activity 不可用"); return; }
        try {
            File apk = new File(path);
            if (!apk.exists()) { call.reject("APK 不存在: " + path); return; }
            Uri uri;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                // FileProvider：authority 与 AndroidManifest.xml 的 provider 一致
                uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", apk);
            } else {
                uri = Uri.fromFile(apk);
            }
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("安装调起失败: " + e.getMessage());
        }
    }
}
