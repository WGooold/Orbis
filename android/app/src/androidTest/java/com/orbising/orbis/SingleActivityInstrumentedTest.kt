package com.orbising.orbis

import android.content.ComponentName
import android.content.Intent
import android.os.ParcelFileDescriptor
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The installed launcher alias and the explicit notification/diagnostic entry must keep one
 * Activity and connection hub. Two retained ViewModels repeatedly replace each other's Relay
 * and LAN sessions even though both belong to the same app process and paired Host.
 */
class SingleActivityInstrumentedTest {
    @Test fun launcherThenExplicitEntryKeepsTheSameConnections() = checkEntries(launcherFirst = true)

    @Test fun explicitEntryThenLauncherKeepsTheSameConnections() = checkEntries(launcherFirst = false)

    private fun checkEntries(launcherFirst: Boolean) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val launcher = Intent.makeMainActivity(ComponentName(context.packageName, "dev.pi.remote.MainActivity"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val explicit = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val first = if (launcherFirst) launcher else explicit
        val second = if (launcherFirst) explicit else launcher
        ActivityScenario.launch<MainActivity>(first).use { scenario ->
            lateinit var original: MainActivity
            lateinit var model: RemoteViewModel
            scenario.onActivity {
                original = it
                model = ViewModelProvider(it)[RemoteViewModel::class.java]
            }
            repeat(3) {
                // am -W waits for the asynchronous launch to finish before inspecting ownership.
                val command = "am start -W -n ${second.component!!.flattenToString()} -f 0x10000000" +
                    if (second.action == Intent.ACTION_MAIN) " -a android.intent.action.MAIN -c android.intent.category.LAUNCHER" else ""
                val result = ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command))
                    .bufferedReader().use { it.readText() }
                assertTrue(result, result.contains("Status: ok"))
                instrumentation.waitForIdleSync()
                instrumentation.runOnMainSync {
                    val monitor = ActivityLifecycleMonitorRegistry.getInstance()
                    val live = listOf(Stage.CREATED, Stage.STARTED, Stage.RESUMED, Stage.PAUSED, Stage.STOPPED)
                        .flatMap { stage -> monitor.getActivitiesInStage(stage) }
                        .filterIsInstance<MainActivity>().distinct()
                    assertEquals("Both entry components must retain only one connection owner", listOf(original), live)
                    assertSame(original, monitor.getActivitiesInStage(Stage.RESUMED).filterIsInstance<MainActivity>().single())
                    assertSame(model, ViewModelProvider(original)[RemoteViewModel::class.java])
                }
            }
        }
    }
}
