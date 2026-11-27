# 监督进程用 Windows 作业对象管理本轮所有子进程，结束监督进程会一并停止它们。
param([string]$RunFile, [string]$Marker, [int]$SupervisorPid)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class TurnJob {
    [StructLayout(LayoutKind.Sequential)]
    struct Limits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public Limits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    static IntPtr job;
    public static void Own() {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception();
        if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception();
    }
}
'@
[TurnJob]::Own()
# 在启动 Agent 之前记录监督进程的系统创建时间，Worker 重启后可用它识别进程号是否被复用。
try {
    $started = [System.Diagnostics.Process]::GetProcessById($SupervisorPid).StartTime.ToUniversalTime().Ticks
    [IO.File]::WriteAllText("$RunFile.identity.tmp", "$SupervisorPid $started $Marker")
    [IO.File]::Move("$RunFile.identity.tmp", "$RunFile.identity")
} catch {
    [Console]::Error.WriteLine("无法登记监督进程创建时间，将按本轮命令行标记核对。")
}
& $env:AGENT_AUTOLOOP_NODE --disable-warning=ExperimentalWarning "$PSScriptRoot\run.ts" $RunFile
exit $LASTEXITCODE
