// ScpDriverInterface.dll replacement (a MANAGED assembly). Serves two purposes:
//  1) no-op stubs so Hoiko.exe's C++ module initializer no longer throws
//     "SCP Virtual Bus Device not found", allowing the mixed-mode main module to load;
//  2) an oracle worker that reflects Hoiko's global <Module> search methods and runs
//     SearchAI.Search on a synthetic position, dumping results to console + a file.
//
// C#5-compatible (Wine .NET Framework csc-compatible).

using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace ScpDriverInterface
{
    public enum X360Buttons
    {
        None = 0, Up = 1, Down = 2, Left = 4, Right = 8, Start = 0x10, Back = 0x20,
        LeftStick = 0x40, RightStick = 0x80, LeftBumper = 0x100, RightBumper = 0x200,
        Logo = 0x400, A = 0x1000, B = 0x2000, X = 0x4000, Y = 0x8000
    }

    public sealed class ScpBus : IDisposable
    {
        public ScpBus() { OracleHost.Kickoff(); }
        public ScpBus(int instance) { OracleHost.Kickoff(); }
        public ScpBus(string devicePath) { OracleHost.Kickoff(); }
        public void Close() { }
        public void Dispose() { }
        private void Dispose(bool disposing) { }
        public bool PlugIn(int controllerNumber) { return true; }
        public bool Unplug(int controllerNumber) { return true; }
        public bool UnplugAll() { return true; }
        public bool Report(int controllerNumber, byte[] controllerReport) { return true; }
        public bool Report(int controllerNumber, byte[] controllerReport, byte[] outputBuffer) { return true; }
    }

    public sealed class X360Controller
    {
        public X360Controller() { }
        public X360Controller(X360Buttons buttons, byte leftTrigger, byte rightTrigger,
            short leftStickX, short leftStickY, short rightStickX, short rightStickY)
        {
            Buttons = buttons; LeftTrigger = leftTrigger; RightTrigger = rightTrigger;
            LeftStickX = leftStickX; LeftStickY = leftStickY;
            RightStickX = rightStickX; RightStickY = rightStickY;
        }
        public X360Controller(X360Controller controller)
        {
            if (controller != null)
            {
                Buttons = controller.Buttons; LeftTrigger = controller.LeftTrigger;
                RightTrigger = controller.RightTrigger; LeftStickX = controller.LeftStickX;
                LeftStickY = controller.LeftStickY; RightStickX = controller.RightStickX;
                RightStickY = controller.RightStickY;
            }
        }
        public X360Buttons Buttons { get; set; }
        public byte LeftTrigger { get; set; }
        public byte RightTrigger { get; set; }
        public short LeftStickX { get; set; }
        public short LeftStickY { get; set; }
        public short RightStickX { get; set; }
        public short RightStickY { get; set; }
        public byte[] GetReport() { return new byte[0x1c]; }
    }
}

internal static class OracleHost
{
    private const int RootBufSize = 8192;
    private const int OffBoard = 216;
    private const int OffElapsed = 432;
    private const int OffNodeCount = 440;
    private const int OffDepth = 444;
    private const int OffClear = 448;
    private const int OffBeam = 452;
    private const int OffFirstMove = 456;
    private const int OffMoveSeq = 468;

    private static int _started;
    private static bool _initDone;
    private static bool _startTimer;
    private static bool _twoSearch;
    private static string _logPath;
    private static StreamWriter _file;

    public static void Kickoff()
    {
        if (Interlocked.Exchange(ref _started, 1) != 0) return;
        Thread t = new Thread(Worker);
        t.IsBackground = true;
        t.Start();
    }

    private static void Worker()
    {
        Exception last = null;
        for (int attempt = 0; attempt < 40; attempt++)
        {
            try
            {
                if (RunOnce()) { Log("ORACLE_OK"); Flush(); Environment.Exit(0); }
            }
            catch (Exception e) { last = e; }
            Flush();
            Thread.Sleep(250);
        }
        Log("ORACLE_FAIL after retries: " + Describe(last));
        Flush();
        Environment.Exit(1);
    }

    private static bool RunOnce()
    {
        Assembly asm = Assembly.GetEntryAssembly();
        if (asm == null) { Log("[wait] no entry assembly yet"); return false; }
        _asm = asm;

        MethodInfo miConfigRead = Resolve(0x0600012d, "ConfigAI.ReadConfig", 0);
        MethodInfo miSearchInit = Resolve(0x06000208, "SearchAI.Init", 0);
        MethodInfo miSearchReadConfig = Resolve(0x0600020a, "SearchAI.ReadConfig", 0);
        MethodInfo miRootInit = Resolve(0x0600011f, "RootNode.Init", 2);
        MethodInfo miUpdateMaxHeight = Resolve(0x0600025a, "Board.UpdateMaxHeight", 1);
        MethodInfo miSearch = Resolve(0x0600020e, "SearchAI.Search", 1);
        MethodInfo miIsSearching = Resolve(0x0600020d, "SearchAI.IsSearching", 1);
        MethodInfo miGetDelay = Resolve(0x06000126, "RootNode.GetDelay", 1);
        if (miRootInit == null || miSearch == null)
        {
            Log("[wait] search methods not visible yet (entry=" + asm.GetName().Name + ")");
            return false;
        }

        if (!_initDone)
        {
            Log("[1] ConfigAI.ReadConfig"); Invoke(miConfigRead);
            Log("[2] SearchAI.Init"); Invoke(miSearchInit);
            Log("[3] SearchAI.ReadConfig"); Invoke(miSearchReadConfig);
            _initDone = true;
        }

        int[] seq = new int[] { 0,1,2,3,4,5,6, 0,1,2,3,4,5,6, 0,1,2,3,4,5,6, 0,1,2,3,4,5,6 };
        int[] board = new int[32];
        board[0] = 0x1FF;
        board[1] = 0x001;
        board[2] = 0x001;
        board[3] = 0x001;
        LoadInput(ref seq, board);

        IntPtr buf = Marshal.AllocHGlobal(RootBufSize);
        for (int i = 0; i < RootBufSize; i += 8) Marshal.WriteInt64(buf, i, 0L);
        IntPtr nx = Marshal.AllocHGlobal(28 * 4);
        for (int i = 0; i < 28; i++) Marshal.WriteInt32(nx, i * 4, seq[i % seq.Length]);

        Log("[4] RootNode.Init(root, nextSeq)");
        Invoke(miRootInit, buf, nx);
        for (int r = 0; r < 32; r++)
        {
            if (board[r] == 0) continue;
            Marshal.WriteInt32(buf, OffBoard + r * 4, board[r]);
            Log("     board row " + r + " mask=0x" + board[r].ToString("x3", CultureInfo.InvariantCulture));
        }
        Invoke(miUpdateMaxHeight, new IntPtr(buf.ToInt64() + OffBoard));
        Log("  board.stackHeight @344 = " + Marshal.ReadInt32(buf, 344));
        Log("  fallingMino @152: x=" + Marshal.ReadInt32(buf, 152) + " y=" + Marshal.ReadInt32(buf, 156) + " r=" + Marshal.ReadInt32(buf, 160) + " m=" + Marshal.ReadInt32(buf, 164));

        DateTime t0 = DateTime.UtcNow;
        Log("[5] SearchAI.Search(root)");
        if (_startTimer && miIsSearching != null)
        {
            Log("[4d] SearchAI.IsSearching(true)  (starts timer, limit=1000ms)");
            Invoke(miIsSearching, true);
        }
        Invoke(miSearch, buf);
        Log("[5] returned in " + (DateTime.UtcNow - t0).TotalMilliseconds.ToString("0.0", CultureInfo.InvariantCulture) + " ms");

        Log("");
        Log("================ SEARCH RESULT ================");
        Log("  nodeCount  @440 = " + Marshal.ReadInt32(buf, OffNodeCount));
        Log("  depth      @444 = " + Marshal.ReadInt32(buf, OffDepth));
        Log("  clear/score@448 = " + Marshal.ReadInt32(buf, OffClear));
        Log("  beamLimit  @452 = " + Marshal.ReadInt32(buf, OffBeam));
        Log("  elapsed    @432 = " + BitConverter.Int64BitsToDouble(Marshal.ReadInt64(buf, OffElapsed)).ToString("0.000", CultureInfo.InvariantCulture));
        if (miGetDelay != null) Log("  GetDelay        = " + Convert.ToString(Invoke(miGetDelay, buf), CultureInfo.InvariantCulture));
        Log("  moveDelay @400  = " + Marshal.ReadInt32(buf, 400));
        Log("  act       @416  = " + Marshal.ReadInt32(buf, 416));
        Log("  root GamePack board @216 row0 = 0x" + Marshal.ReadInt32(buf, 216).ToString("x3", CultureInfo.InvariantCulture));

        Log("");
        Log("-------------- CHOSEN MOVE (decoded) --------------");
        DumpFallMino("firstMove @456", buf, OffFirstMove);
        for (int i = 0; i < 14; i++)
        {
            int off = OffMoveSeq + i * 32;
            if (Marshal.ReadInt32(buf, off) == 7 && i > 0) { Log("      seq[" + i + "] sentinel(7) - end"); break; }
            DumpFallMino("seq[" + i + "] @" + off, buf, off);
        }

        Log("");
        Log("-------------- RAW HEX --------------");
        Log("best GamePack @120..424: " + Hex(buf, 120, 304));
        Log("result region @432..960: " + Hex(buf, 432, 528));
        Log("final board  @216..344: " + Hex(buf, OffBoard, 128));

        if (_twoSearch && miSearch != null)
        {
            Log("");
            Log("[6] SECOND SEARCH (reads global beamSizeLimit adapted by search 1's SetNextOption)");
            IntPtr buf2 = Marshal.AllocHGlobal(RootBufSize);
            for (int i = 0; i < RootBufSize; i += 8) Marshal.WriteInt64(buf2, i, 0L);
            IntPtr nx2 = Marshal.AllocHGlobal(28 * 4);
            for (int i = 0; i < 28; i++) Marshal.WriteInt32(nx2, i * 4, seq[i % seq.Length]);
            Invoke(miRootInit, buf2, nx2);
            for (int r = 0; r < 32; r++)
            {
                if (board[r] != 0) Marshal.WriteInt32(buf2, OffBoard + r * 4, board[r]);
            }
            Invoke(miUpdateMaxHeight, new IntPtr(buf2.ToInt64() + OffBoard));
            Invoke(miSearch, buf2);
            Log("  search2 depth @444     = " + Marshal.ReadInt32(buf2, OffDepth));
            Log("  search2 beamLimit @452 = " + Marshal.ReadInt32(buf2, OffBeam));
            if (miGetDelay != null) Log("  search2 GetDelay       = " + Convert.ToString(Invoke(miGetDelay, buf2), CultureInfo.InvariantCulture));
            Marshal.FreeHGlobal(buf2);
            Marshal.FreeHGlobal(nx2);
        }

        Marshal.FreeHGlobal(buf);
        Marshal.FreeHGlobal(nx);
        return true;
    }

    private static Assembly _asm;

    private static MethodInfo Resolve(int token, string name, int argc)
    {
        try
        {
            MethodInfo mi = (MethodInfo)_asm.ManifestModule.ResolveMethod(token);
            if (mi != null)
            {
                Log("[resolve] token 0x" + token.ToString("x8") + " -> " + name + " OK");
                return mi;
            }
        }
        catch (Exception e)
        {
            Log("[resolve] token 0x" + token.ToString("x8") + " (" + name + ") FAILED: " + e.GetType().Name + ": " + e.Message);
        }
        Type mod = null;
        try { mod = _asm.GetType("<Module>", false); } catch { }
        if (mod == null)
        {
            Type[] ts; try { ts = _asm.GetTypes(); } catch (ReflectionTypeLoadException e) { ts = e.Types; }
            for (int i = 0; i < ts.Length && mod == null; i++)
                if (ts[i] != null && ts[i].Name == "<Module>") mod = ts[i];
        }
        return mod == null ? null : Find(mod, name, argc);
    }

    private static void LoadInput(ref int[] seq, int[] board)
    {
        string path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "oracle_input.txt");
        if (!File.Exists(path)) { Log("[input] oracle_input.txt not found - using built-in synthetic position"); return; }
        foreach (string raw in File.ReadAllLines(path))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith("#") || line.StartsWith("//")) continue;
            int eq = line.IndexOf('=');
            if (eq <= 0) continue;
            string key = line.Substring(0, eq).Trim().ToLowerInvariant();
            string val = line.Substring(eq + 1).Trim();
            string[] parts = val.Split(',');
            if (key == "next")
            {
                int[] s = new int[parts.Length];
                for (int i = 0; i < parts.Length; i++) s[i] = int.Parse(parts[i].Trim(), CultureInfo.InvariantCulture);
                if (s.Length > 0) seq = s;
            }
            else if (key == "board")
            {
                for (int i = 0; i < parts.Length && i < 32; i++)
                    board[i] = (int)long.Parse(parts[i].Trim().Replace("0x", ""), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            }
            else if (key == "timer")
            {
                _startTimer = val != "0";
            }
            else if (key == "twosearch")
            {
                _twoSearch = val != "0";
            }
        }
        Log("[input] loaded oracle_input.txt (board rows=" + board.Length + ", next=" + seq.Length + ")");
    }

    private static MethodInfo Find(Type mod, string name, int argc)
    {
        MethodInfo[] ms = mod.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        for (int i = 0; i < ms.Length; i++)
            if (ms[i].Name == name && ms[i].GetParameters().Length == argc) return ms[i];
        return null;
    }

    private static object Invoke(MethodInfo m, params object[] args)
    {
        if (m == null) throw new InvalidOperationException("null method");
        try { return m.Invoke(null, args); }
        catch (TargetInvocationException e)
        {
            Exception inner = e.InnerException != null ? e.InnerException : e;
            throw new Exception("Invoke [" + m.Name + "] -> " + inner.GetType().FullName + ": " + inner.Message
                + " | stack: " + inner.StackTrace, inner);
        }
    }

    private static void DumpFallMino(string label, IntPtr p, int off)
    {
        Log("  " + label + ": x=" + Marshal.ReadInt32(p, off)
            + " y=" + Marshal.ReadInt32(p, off + 4)
            + " rot=" + Marshal.ReadInt32(p, off + 8)
            + " m=" + Marshal.ReadInt32(p, off + 12)
            + "  raw " + Hex(p, off, 32));
    }

    private static string Hex(IntPtr p, int off, int len)
    {
        byte[] b = new byte[len];
        Marshal.Copy(new IntPtr(p.ToInt64() + off), b, 0, len);
        StringBuilder sb = new StringBuilder(len * 3);
        for (int i = 0; i < len; i++) sb.Append(b[i].ToString("x2", CultureInfo.InvariantCulture)).Append(' ');
        return sb.ToString();
    }

    private static string Describe(Exception e)
    {
        if (e == null) return "<none>";
        string s = e.GetType().FullName + ": " + e.Message;
        Exception c = e.InnerException; int d = 0;
        while (c != null && d < 5) { s += " | inner: " + c.GetType().Name + ": " + c.Message; c = c.InnerException; d++; }
        return s;
    }

    private static void Log(string s)
    {
        try { Console.WriteLine(s); } catch { }
        try
        {
            if (_file == null)
            {
                _logPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "oracle_result.txt");
                _file = new StreamWriter(_logPath, false, Encoding.UTF8);
                _file.AutoFlush = true;
            }
            _file.WriteLine(s);
        }
        catch { }
    }

    private static void Flush()
    {
        try { Console.Out.Flush(); } catch { }
        try { if (_file != null) { _file.Flush(); _file.Close(); _file = null; } } catch { }
    }
}
