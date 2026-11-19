using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Capabilities;
using VipCoreApi;
using VipCoreApi.Enums;

namespace VIP_SmokeColor;

public class VipSmokeColor : BasePlugin
{
    public override string ModuleAuthor => "thesamefabius";
    public override string ModuleName => "[VIP] Smoke Color";
    public override string ModuleVersion => "v2.0.0";

    private SmokeColor? _smokeColor;
    private IVipCoreApi? _api;

    public override void OnAllPluginsLoaded(bool hotReload)
    {
        _api = IVipCoreApi.Capability.Get();
        if (_api == null) return;

        _api.OnCoreReady += () =>
        {
            _smokeColor = new SmokeColor(this, _api);
        };
    }

    public override void Unload(bool hotReload)
    {
        _smokeColor?.Dispose();
    }
}

public class SmokeColor : VipFeature<int[]>
{
    public SmokeColor(VipSmokeColor smokeColor, IVipCoreApi api) : base("SmokeColor", api)
    {
        smokeColor.RegisterListener<Listeners.OnEntitySpawned>(OnEntitySpawned);
    }
    
    // TASHER: цвет нужно отправить игрокам (SetStateChanged), а бросившего игрока ищем и через владельца гранаты
    private void OnEntitySpawned(CEntityInstance entity)
    {
        if (entity.DesignerName != "smokegrenade_projectile") return;

        var smokeGrenade = new CSmokeGrenadeProjectile(entity.Handle);
        if (smokeGrenade.Handle == IntPtr.Zero) return;

        Server.NextFrame(() => Apply(smokeGrenade, 0));
    }

    private void Apply(CSmokeGrenadeProjectile smokeGrenade, int attempt)
    {
        if (!smokeGrenade.IsValid) return;

        CCSPlayerPawn? pawn = smokeGrenade.Thrower.Value;
        if (pawn is null && smokeGrenade.OwnerEntity.Value is { IsValid: true } owner)
            pawn = new CCSPlayerPawn(owner.Handle);

        var baseController = pawn is { IsValid: true } ? pawn.Controller.Value : null;
        if (baseController is null || !baseController.IsValid)
        {
            if (attempt < 8) Server.NextFrame(() => Apply(smokeGrenade, attempt + 1));
            return;
        }

        var controller = new CCSPlayerController(baseController.Handle);
        if (!controller.IsValid || !IsFeatureEnabled(controller)) return;

        var smokeColor = GetValue(controller);
        if (smokeColor == null || smokeColor.Length < 3) return;

        smokeGrenade.SmokeColor.X = smokeColor[0] == -1 ? Random.Shared.NextSingle() * 255.0f : smokeColor[0];
        smokeGrenade.SmokeColor.Y = smokeColor[1] == -1 ? Random.Shared.NextSingle() * 255.0f : smokeColor[1];
        smokeGrenade.SmokeColor.Z = smokeColor[2] == -1 ? Random.Shared.NextSingle() * 255.0f : smokeColor[2];
        Utilities.SetStateChanged(smokeGrenade, "CSmokeGrenadeProjectile", "m_vSmokeColor");
    }
}
