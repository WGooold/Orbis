import Foundation
import Testing
@testable import OrbisCore

struct BackgroundTasksTests {
    private let quit = SlashCommand(name: "quit", description: nil, source: "builtin", argument: nil)
    private func tasks(_ status: String = "running", availability: String = "ready") -> BackgroundTaskInventory {
        BackgroundTaskInventory(availability: availability, items: [BackgroundTask(id: "child", title: "检查代码", kind: "Explore", status: status)], truncated: false)
    }
    @Test func backgroundWorkNeverChangesMainInputPhaseAndBlocksQuit() {
        var runtime = RuntimeSummary(runtimeId: "r", name: "Claude", cwd: "/repo", status: "idle", backgroundTasks: tasks())
        #expect(runtime.status == "idle")
        #expect(runtime.presentationTitle == "1 个子任务运行中")
        #expect(runtime.presentationStatus == "background")
        #expect(!runtime.allowsRemoteClose([quit]))
        runtime.status = "running"
        #expect(runtime.presentationTitle == "运行中 · 1 个子任务")
        runtime.status = "waiting_local_interaction"
        #expect(runtime.presentationTitle == "等待确认")
        runtime.status = "idle"
        runtime.backgroundTasks = tasks("completed")
        #expect(runtime.presentationTitle == "空闲")
        #expect(runtime.allowsRemoteClose([quit]))
        #expect(!runtime.allowsRemoteClose([]))
    }
    @Test func unknownAndIncompleteInventoryNeverProvesIdleOrClosure() throws {
        var inventory = tasks(availability: "unknown")
        #expect(inventory.activityTitle == "子任务状态待核对")
        #expect(!inventory.allowsQuit)
        #expect(try JSONDecoder().decode(BackgroundTaskInventory.self, from: JSONEncoder().encode(inventory)) == inventory)
        inventory = tasks("unknown")
        #expect(!inventory.confirmed)
        inventory = tasks("completed"); inventory.truncated = true
        #expect(!inventory.valid)
        #expect(!inventory.allowsQuit)
        inventory = tasks(); inventory.items.append(inventory.items[0])
        #expect(!inventory.valid)
    }
    @Test func pendingAndWaitingAreNotReportedAsRunning() {
        #expect(tasks("pending").activityTitle == "1 个子任务启动中")
        #expect(tasks("waiting").activityTitle == "1 个子任务等待中")
        #expect(tasks("idle").activityTitle == nil)
    }
}
