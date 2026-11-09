// Orbis 测试用途（场景与判定见本文件断言）：
// - Claude 后台子任务（S26、S17、S20、V05、V12、V16、V18、M03、M06、M10、M20）
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
        #expect(runtime.presentationTitle == "运行中，1 个子任务")
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

    // S33 / SC52: all Agent kinds reuse the same local, read-only task presentation.
    @Test func genericSubagentLabelsAndPartialInventoryKeepKnownWorkVisible() {
        let labels = ["pending": "启动中", "running": "工作中", "waiting": "等待", "idle": "空闲",
                      "completed": "完成", "failed": "失败", "killed": "已停止", "unknown": "未知"]
        for (status, title) in labels { #expect(tasks(status).items[0].statusTitle == title) }
        var previous = tasks()
        previous.items.append(BackgroundTask(id: "retained", title: "已有任务", kind: "agent", status: "running"))
        let partial = BackgroundTaskInventory(availability: "unknown", items: [
            BackgroundTask(id: "child", title: "代码检查", kind: "agent", status: "completed"),
            BackgroundTask(id: "next", parentId: "child", title: "等待检查", kind: "agent", status: "waiting")], truncated: true)
            .reconciled(previous: previous)
        #expect(partial.valid)
        #expect(partial.items.map(\.id) == ["child", "retained", "next"])
        #expect(partial.items.map(\.statusTitle) == ["完成", "工作中", "等待"])
        #expect(partial.items.last?.parentId == "child")
        #expect(partial.panelTitle == "子代理 3 项，清单不完整")
        #expect(partial.inventoryNotice == "清单不完整，显示已知任务")
        #expect(!partial.confirmed)
        #expect(!partial.allowsQuit)
        for kind in ["pi", "codex", "codexDesktop", "claude", "deepseek"] {
            let runtime = RuntimeSummary(runtimeId: "r", name: "Agent", cwd: "/repo", status: "idle", agentKind: kind, backgroundTasks: partial)
            #expect(runtime.status == "idle")
            #expect(runtime.presentationStatus == "background")
            #expect(runtime.presentationTitle == "1 个子代理工作中，1 个子代理等待，清单不完整")
            var mainRunning = runtime; mainRunning.status = "running"
            #expect(mainRunning.presentationTitle == "运行中，1 个子代理工作中，1 个子代理等待，清单不完整")
            #expect(!runtime.allowsRemoteClose([quit]))
        }
        let stale = tasks("failed", availability: "unknown").reconciled(previous: partial)
        #expect(stale.items == partial.items)
        #expect(!stale.truncated)
        #expect(stale.activityTitle == "子任务状态待核对")
        #expect(stale.panelTitle == "子代理 3 项，状态待核对")
        #expect(stale.inventoryNotice == "状态待核对，显示最后已知信息")
        #expect(tasks("completed").panelTitle == "子代理 1 项")
        #expect(tasks("completed").inventoryNotice == nil)
        #expect(tasks("completed").reconciled(previous: partial).confirmed)
    }

    // Keep the bounded display inventory valid when disjoint partial observations accumulate.
    @Test func partialInventoryPrioritizesIncomingRowsAtTheDisplayLimit() {
        let previous = BackgroundTaskInventory(availability: "ready", items: (0..<256).map {
            BackgroundTask(id: "old-\($0)", title: "已有任务", kind: "agent", status: "running") }, truncated: false)
        var incoming = tasks("failed", availability: "unknown"); incoming.truncated = true
        let merged = incoming.reconciled(previous: previous)
        #expect(merged.valid)
        #expect(merged.items.count == 256)
        #expect(merged.items.first { $0.id == "child" }?.status == "failed")
    }

    // Unsupported / never-observed task sources must not turn ordinary idle sessions into unknown tasks.
    @Test func firstUnknownEmptyInventoryDoesNotShowAWarningOrChangeMainPresentation() {
        var inventory = BackgroundTaskInventory(availability: "unknown", items: [], truncated: false)
        #expect(inventory.valid)
        #expect(!inventory.visible)
        #expect(inventory.activityTitle == nil)
        var runtime = RuntimeSummary(runtimeId: "r", name: "Agent", cwd: "/repo", status: "idle", backgroundTasks: inventory)
        #expect(runtime.presentationStatus == "idle")
        #expect(runtime.presentationTitle == "空闲")
        // No task evidence must not veto the backend's native quit capability.
        #expect(runtime.allowsRemoteClose([quit]))
        #expect(!runtime.allowsRemoteClose([]))
        runtime.status = "running"
        #expect(runtime.presentationTitle == "运行中")
        inventory.truncated = true
        #expect(inventory.visible)
    }
}
