# Innov-IoT Rental Bike Incident Detection System
## Master Project Information & Development Plan

**Competition:** CodeFest Innov-IoT  
**Project:** Smart Rental Bike Incident Detection & Emergency Assistance System  
**Demo:** Miniature/model motorcycle  
**Budget target:** LKR 15,000–30,000  
**Target period:** Before 23 September 2026  
**Last consolidated:** 18 September 2026

---

## 1. Project Purpose

Innov-IoT is a smart rental motorcycle safety system. It monitors motorcycle movement, detects possible incidents, obtains the motorcycle location, captures front-camera evidence, alerts the rider, and escalates an emergency when help is required or the rider does not respond.

### Core flow

```text
Motorcycle monitoring
        ↓
Possible incident detected
        ↓
Analyze motion/event
        ↓
GPS location + camera image
        ↓
15-second rider confirmation
        ↓
SAFE / NEED HELP / No response
        ↓
Emergency alert when required
        ↓
GSM SMS + backend/application
        ↓
Owner/operator dashboard
```

---

# 2. Main Objectives

1. Detect possible motorcycle incidents automatically.
2. Reduce false alarms using sensor/event logic.
3. Obtain incident location using GPS.
4. Capture front-camera evidence.
5. Give the rider 15 seconds to respond.
6. Provide SAFE and NEED HELP controls.
7. Send emergency information through GSM/SMS.
8. Display incidents to the owner/operator.
9. Store incident information in a backend/database.
10. Build a compact, reliable competition prototype.

---

# 3. Complete Hardware

| Component | Current selection | Main purpose |
|---|---|---|
| Main controller | ESP32 DevKit V1 | Main processing/control |
| Motion sensor | MPU6050 | Acceleration, gyro, tilt/impact |
| GPS | NEO-6M / MD0561 | Location |
| GSM | SIM800L GSM Module with Antenna v2.2 / MD0147 | SMS/mobile communication |
| Camera | ESP32-CAM | Front image |
| Battery | 7.4 V, 1500 mAh, 2S LiPo, 90C | Main power |
| Buck converter | 7.4 V → regulated 5 V | Power conversion |
| Buzzer | Exact type pending | Audible warning |
| SAFE button | Push button, exact type pending | Rider confirms safe |
| HELP button | Push button, exact type pending | Rider requests help |
| LEDs | 3 LEDs | Status indication |
| Dot/perforated board | 14.5 cm × 6.3 cm planned | Physical circuit |
| Resistors/capacitors | Based on final circuit | LED limiting/filtering/decoupling |
| Antennas | GSM/GPS according to modules | Wireless reception |

---

# 4. Main ESP32 GPIO Plan

| Function | GPIO | Status |
|---|---:|---|
| MPU6050 SDA | GPIO21 | Planned |
| MPU6050 SCL | GPIO22 | Planned |
| MD0147 TX from ESP32 | GPIO17 | Planned |
| MD0147 RX to ESP32 | GPIO16 | Planned |
| Ignition/status | GPIO32 | Planned; physical signal pending |
| SAFE button | GPIO33 | Planned |
| HELP button | GPIO25 | Planned |
| Buzzer | GPIO23 | Planned |
| LED 1 | GPIO18 | Planned |
| LED 2 | GPIO19 | Planned |
| LED 3 | GPIO13 | Planned |
| GPS UART | TBD | Must finalize |
| ESP32-CAM communication | TBD | Must finalize |

**Do not physically solder the TBD connections until the final communication architecture is confirmed.**

---

# 5. MPU6050

## Purpose

The MPU6050 is the primary motion sensor.

It provides:
- 3-axis accelerometer
- 3-axis gyroscope

It can support detection of:
- Sudden impact
- Sudden acceleration/deceleration
- Abnormal rotation
- Tilt
- Fall
- Rollover
- Hard cornering

## Current I2C

```text
ESP32 GPIO21 → MPU6050 SDA
ESP32 GPIO22 → MPU6050 SCL
ESP32 3.3V   → MPU6050 VCC
ESP32 GND    → MPU6050 GND
```

Typical address:

```text
0x68
```

The exact purchased MPU6050 board should be checked before final physical construction.

---

# 6. NEO-6M GPS / MD0561

## Purpose

Provides:
- Latitude
- Longitude
- Position
- Time information where available

Used for:
- Incident location
- Emergency SMS
- Owner map
- Incident record

## Still pending

- Exact UART GPIOs
- Exact board pin labels
- Exact physical dimensions
- Antenna arrangement
- Final mounting location

GPS should be tested outdoors because satellite acquisition may be poor indoors.

---

# 7. GSM — MD0147

## Confirmed hardware

**SIM800L GSM Module with Antenna v2.2 — MD0147**

This is the confirmed GSM board for the project.

### Important correction

Do not replace the MD0147-specific design with generic bare-SIM800L power instructions.

---

# 8. MD0147 Power Plan

Confirmed project architecture:

```text
7.4 V 2S LiPo
       ↓
Buck Converter
       ↓
Regulated 5 V
       ↓
MD0147 main 5 V input
```

Logic reference:

```text
ESP32 3.3 V
       ↓
MD0147 VDD logic reference
```

Ground:

```text
ESP32 GND
   ├── MD0147 GND
   ├── GPS GND
   ├── MPU6050 GND
   ├── Camera/system GND
   └── Other required grounds
```

### Rules

- Never connect raw 7.4 V to the MD0147 5 V input.
- Do not use a resistor divider as a power regulator.
- Do not blindly apply bare SIM800L 4 V power instructions.
- Confirm the actual MD0147 board labels before soldering.
- The buck converter must have adequate current capability for GSM transmission peaks.

---

# 9. MD0147 UART

Current plan:

```text
ESP32 GPIO17 TX  → MD0147 RXD
MD0147 TXD       → ESP32 GPIO16 RX
ESP32 GND        → MD0147 GND
ESP32 3.3 V      → MD0147 VDD
Buck 5 V         → MD0147 main 5 V
```

The actual board labels must be checked against the physical MD0147 board before permanent wiring.

---

# 10. GSM/SMS Function

GSM provides emergency communication over the cellular network.

An alert can contain:

```text
INNOV-IOT ALERT

Vehicle: BIKE-001
Incident: Possible Collision
Time: <timestamp>

Location:
<latitude>, <longitude>

Rider response:
HELP / No response
```

The final message format can be changed during implementation.

---

# 11. ESP32-CAM

## Purpose

The front camera provides visual evidence.

Planned sequence:

```text
Incident detected
      ↓
ESP32-CAM captures image
      ↓
Image transferred/stored
      ↓
Backend/application
      ↓
Owner dashboard
```

### Physical location

Preferably mount the camera at the front of the motorcycle model.

### Pending decisions

- Exact ESP32-CAM variant
- Power method
- Communication method with main ESP32
- GPIO assignment
- Image transfer/storage architecture

---

# 12. Battery

Confirmed:

- 2S LiPo
- 7.4 V nominal
- 1500 mAh
- 90C

The battery is the main energy source.

### Safety

- Check polarity before connection.
- Prevent short circuits.
- Protect the battery physically.
- Use a suitable 2S LiPo charger/balancer.
- Do not charge an unsafe/damaged battery.
- Measure voltage before connecting the electronics.

---

# 13. Buck Converter

Purpose:

```text
Battery ~7.4 V
      ↓
Buck converter
      ↓
Regulated 5 V
```

Before final construction verify:
- Exact model
- Input range
- Output voltage
- Current rating
- Terminal labels
- Physical size

Set and measure the output before connecting sensitive electronics.

---

# 14. Ignition / Status Input

Current GPIO:

```text
GPIO32
```

Purpose:
- Indicate whether the motorcycle/system is active.
- Help distinguish normal operation from unauthorized movement.

The exact physical signal is not yet confirmed.

It may be:
- Switch
- Logic signal
- Model ignition circuit
- Other sensor

The actual GPIO32 voltage must be verified before connection.

---

# 15. SAFE Button

Current GPIO:

```text
GPIO33
```

Purpose:
Cancel/acknowledge an incident when the rider is safe.

Possible simple connection:

```text
GPIO33 ─── SAFE button ─── GND
```

with an appropriate ESP32 pull-up configuration if used.

Exact button type and physical location remain to be confirmed.

---

# 16. HELP Button

Current GPIO:

```text
GPIO25
```

Purpose:
Confirm that assistance is required.

Possible connection:

```text
GPIO25 ─── HELP button ─── GND
```

Exact button type and physical location remain to be confirmed.

---

# 17. Buzzer

Current GPIO:

```text
GPIO23
```

Uses:
- Incident warning
- Countdown
- Emergency indication

Still verify:
- Active/passive
- Rated voltage
- Current
- Whether a transistor driver is required

Do not assume every buzzer can be connected directly to an ESP32 GPIO.

---

# 18. LEDs

Three status LEDs:

| LED | GPIO | Planned purpose |
|---|---:|---|
| LED 1 | GPIO18 | Power/System |
| LED 2 | GPIO19 | GPS/GSM/communication |
| LED 3 | GPIO13 | Incident/Alert |

Each LED should have an appropriate current-limiting resistor.

Final LED colors, sizes and resistor values are pending physical verification.

---

# 19. Dot Board

Planned board:

**14.5 cm × 6.3 cm**

Before final layout verify:
- Hole spacing
- Single/double-sided construction
- Connected vs isolated holes
- Thickness
- Mounting holes
- Available usable area
- Height restrictions

The final layout should prioritize reliability and hand-soldering.

---

# 20. Physical Layout Strategy

Conceptual arrangement:

```text
+-------------------------------------------------------+
| GPS / antenna area                    GSM antenna     |
|                                                       |
| [GPS]                         [MD0147 GSM]            |
|                                                       |
| [MPU6050]       [ESP32]          [BUCK]              |
|                                                       |
| [LEDs] [SAFE] [HELP] [BUZZER]       POWER            |
+-------------------------------------------------------+
                 14.5 cm × 6.3 cm
```

This is only a planning illustration. Actual placement requires component photographs and measurements.

The ESP32-CAM should preferably be mounted separately at the motorcycle front.

Battery and antennas may also be positioned separately if needed.

---

# 21. Incident Types

The intended categories are:

1. Normal standing/parking
2. Parked fall
3. Low-speed drop
4. Pothole
5. Collision
6. Hard cornering
7. Rollover
8. Towing
9. Tampering

The first prototype can use threshold/rule-based sensor fusion. More advanced AI classification can be added later.

---

# 22. Incident Detection Logic

```text
Read MPU6050
     ↓
Acceleration + gyroscope
     ↓
Check motion features
     ↓
Sudden impact?
Sudden rotation?
Abnormal tilt?
Sustained abnormal orientation?
     ↓
Incident candidate
     ↓
Time-window analysis
     ↓
Incident classification
     ↓
Confirmed incident
```

A single small sensor spike should not automatically create an emergency alert.

---

# 23. False Alarm Reduction

Use combinations of:
- Accelerometer threshold
- Gyroscope threshold
- Tilt threshold
- Event duration
- Motion sequence
- Ignition/status
- Rider confirmation

Example:

```text
Small movement
    ↓
Normal

Large acceleration
+
Large angular movement
+
Abnormal tilt
    ↓
Possible serious incident
```

Thresholds must be calibrated experimentally using the physical model.

---

# 24. 15-Second Confirmation

The planned rider workflow is:

```text
Incident detected
      ↓
Warning
      ↓
15-second countdown
      ↓
+---------------------+
|                     |
SAFE                HELP
|                     |
↓                     ↓
Cancel             Emergency
alert              assistance
                      |
                      ↓
                  GSM/App
```

If there is no response:

```text
No response
     ↓
Emergency escalation
```

---

# 25. Renter Application

The renter interface should be simple.

```text
+--------------------------+
|    INCIDENT DETECTED     |
|                          |
|        00:15             |
|                          |
|      Are you safe?       |
|                          |
| [ SAFE ] [ NEED HELP ]   |
+--------------------------+
```

The user should not need to navigate through many screens during an emergency.

---

# 26. Owner Dashboard

Planned information:

- Vehicle status
- Last/current location
- Map
- Incident type
- Time
- Severity
- Camera image
- Rider response
- Alert history
- Escalation state

Conceptually:

```text
Vehicle
  ↓
Incident
  ├── Location
  ├── Time
  ├── Type
  ├── Image
  ├── Rider response
  └── Alert status
```

---

# 27. Backend / Database

The backend can contain:

## Vehicle
- Vehicle ID
- Status
- Last location
- Last communication

## Rider/Rental
- Rider ID
- Rental ID
- Vehicle ID
- Rental status

## Incident
- Incident ID
- Vehicle ID
- Rider ID
- Incident type
- Severity
- Timestamp
- Latitude
- Longitude
- Sensor data
- Rider response
- Escalation status
- Image reference

## Alert
- Alert ID
- Incident ID
- Recipient
- Channel
- Time
- Status

---

# 28. Example API Architecture

Possible endpoints:

```text
POST /api/incidents
GET  /api/incidents
GET  /api/incidents/{id}

POST /api/vehicles/{id}/location
GET  /api/vehicles/{id}/location

POST /api/incidents/{id}/image
GET  /api/incidents/{id}/image

POST /api/incidents/{id}/safe
POST /api/incidents/{id}/help
```

These are proposed architecture examples, not a final API contract.

---

# 29. Communication Architecture

```text
Motorcycle
    |
    +---- GSM/SMS ----------------→ Emergency contact
    |
    +---- Network/API ------------→ Backend
                                      |
                                      +→ Database
                                      |
                                      +→ Image storage
                                      |
                                      +→ Renter application
                                      |
                                      +→ Owner dashboard
```

The exact ESP32-CAM image-transfer method is still pending.

---

# 30. Testing Plan

## Test 1 — ESP32
- Power on
- Upload firmware
- GPIO test
- Serial test

## Test 2 — MPU6050
- Detect I2C
- Confirm `0x68`
- Test acceleration
- Test gyro
- Test tilt

## Test 3 — GPS
- UART test
- NMEA data
- Outdoor satellite fix
- Latitude/longitude validation

## Test 4 — MD0147
- Measure 5 V
- Power startup
- AT commands
- SIM/network registration
- Signal check
- SMS test

## Test 5 — Buttons
- SAFE
- HELP
- Debounce

## Test 6 — Buzzer/LEDs
- GPIO output
- Current/voltage check
- Status patterns

## Test 7 — ESP32-CAM
- Boot
- Capture
- Image transfer/storage

## Test 8 — Integrated incident
```text
Motion
→ Detection
→ Countdown
→ SAFE/HELP
→ GPS
→ Camera
→ GSM
→ Backend
→ Dashboard
```

---

# 31. Physical Construction Procedure

### Stage 1
Photograph and identify every module.

### Stage 2
Measure every module.

### Stage 3
Confirm all pin labels.

### Stage 4
Create final GPIO table.

### Stage 5
Create power/ground rails.

### Stage 6
Place components on the 14.5 × 6.3 cm board.

### Stage 7
Solder simple components first.

### Stage 8
Solder MPU6050/I2C.

### Stage 9
Solder GPS/GSM UARTs after final pin verification.

### Stage 10
Connect external camera/antenna/battery wiring.

### Stage 11
Continuity-test the board.

### Stage 12
Power the system gradually and test each subsystem.

---

# 32. Important Physical Safety Rules

1. Never connect 7.4 V directly to a 5 V-only input.
2. Measure buck output before connecting modules.
3. Check positive/negative polarity.
4. Keep all required grounds common.
5. Ensure adequate GSM power capacity.
6. Keep the GSM antenna connected when transmitting.
7. Protect the LiPo from shorts.
8. Do not use unknown voltage on ESP32 GPIOs.
9. Use current-limiting resistors for LEDs.
10. Use a transistor driver for a buzzer if its current exceeds safe GPIO capability.
11. Avoid permanent soldering until the pin map is confirmed.
12. Inspect every solder joint for shorts.

---

# 33. Competition Demo Plan

### Scenario

1. Power on system.
2. Show normal motorcycle monitoring.
3. Simulate an incident.
4. Show incident detection.
5. Start 15-second countdown.
6. Demonstrate SAFE or HELP.
7. Show GPS location.
8. Capture/show camera image.
9. Send GSM/SMS alert.
10. Show owner dashboard.
11. Show incident record.

---

# 34. Demo Reliability

A controlled demo mode is useful because:
- GPS can fail indoors.
- GSM network can vary.
- Camera/network conditions can vary.
- Sensor thresholds can behave differently between tests.

Demo mode can provide predictable test conditions while the normal system remains the actual design.

---

# 35. Promotional Video Plan

Approximate duration:

**1 minute 20 seconds**

Sequence:

```text
Rental motorcycle
      ↓
Sensors monitoring
      ↓
Incident occurs
      ↓
Automatic detection
      ↓
15-second rider confirmation
      ↓
Camera captures evidence
      ↓
GPS identifies location
      ↓
GSM sends alert
      ↓
Owner receives alert
      ↓
Emergency response concept
```

Each video clip should connect visually to the previous clip.

---

# 36. Major Risks and Solutions

| Risk | Planned solution |
|---|---|
| GSM power instability | Adequate buck/current capacity |
| GPS no indoor fix | Outdoor testing/demo fallback |
| False alarms | Sensor fusion + confirmation |
| GPIO conflict | Final pin review |
| Camera complexity | Independent camera test |
| UART conflict | Dedicated/verified UART plan |
| Board too small | Measure modules before placement |
| Loose wires | Continuity testing |
| Battery short | Physical protection |
| Network failure | Controlled demo/fallback |

---

# 37. Confirmed Decisions

- Main controller: ESP32.
- Motion sensor: MPU6050.
- GPS: NEO-6M / MD0561.
- GSM: **SIM800L GSM Module with Antenna v2.2 / MD0147**.
- Camera: ESP32-CAM.
- Battery: **7.4 V / 1500 mAh / 2S LiPo / 90C**.
- Buck converter: used to create regulated 5 V.
- MD0147 VDD logic reference: ESP32 3.3 V.
- Common ground: required.
- Rider controls: SAFE / NEED HELP.
- Confirmation: 15 seconds.
- Emergency communication: GSM/SMS.
- Owner interface: map + incident + camera image.
- Planned dot board: 14.5 cm × 6.3 cm.

---

# 38. Items Still Requiring Physical Verification

Before final circuit construction, verify:

1. Exact dot-board hole pattern.
2. Exact ESP32 DevKit V1 variant and dimensions.
3. Exact MD0147 pin labels and dimensions.
4. Exact buck converter model/current rating.
5. Exact GPS module/pins/dimensions.
6. Exact ESP32-CAM variant.
7. Camera communication method.
8. Camera power arrangement.
9. Exact MPU6050 module.
10. Buzzer type/voltage/current.
11. SAFE/HELP button type.
12. LED sizes/colors.
13. LED resistor values.
14. Ignition/status signal voltage.
15. Final GPS GPIOs.
16. Final camera communication GPIOs.
17. Final physical placement.
18. Final soldering method.

These are intentionally left as pending rather than guessed.

---

# 39. Final Master Architecture

```text
                       2S LiPo
                    7.4V / 1500mAh
                           |
                           v
                    +-------------+
                    | Buck 5V     |
                    +-------------+
                       |       |
                       v       v
                  MD0147      ESP32
                  GSM          Controller
                    |             |
                    | UART        |
                    +-------------+
                                  |
             +--------------------+--------------------+
             |          |          |          |         |
             v          v          v          v         v
          MPU6050      GPS      SAFE       HELP      Buzzer/LED
             |
             v
       Motion detection

                    ESP32-CAM
                         |
                         v
                   Front image
                         |
                         v
                  Backend/App
                         |
                +--------+--------+
                |                 |
                v                 v
           Renter App        Owner Portal
                                  |
                         +--------+--------+
                         |        |        |
                         v        v        v
                        Map     Image    Alert
```

---

# 40. Development Roadmap

## Phase 1 — Hardware
- [ ] Identify all modules.
- [ ] Confirm physical pin labels.
- [ ] Confirm power requirements.
- [ ] Confirm board dimensions.
- [ ] Finalize physical layout.

## Phase 2 — Individual firmware
- [ ] ESP32
- [ ] MPU6050
- [ ] GPS
- [ ] MD0147
- [ ] Buttons
- [ ] Buzzer
- [ ] LEDs
- [ ] ESP32-CAM

## Phase 3 — Incident engine
- [ ] Motion thresholds
- [ ] Event windows
- [ ] Classification
- [ ] False-alarm handling

## Phase 4 — Emergency workflow
- [ ] 15-second timer
- [ ] SAFE
- [ ] HELP
- [ ] No-response escalation
- [ ] GSM SMS

## Phase 5 — Application
- [ ] Backend
- [ ] Database
- [ ] Image storage
- [ ] Renter UI
- [ ] Owner dashboard

## Phase 6 — Integration
- [ ] Sensor + incident
- [ ] Incident + GPS
- [ ] Incident + camera
- [ ] Incident + GSM
- [ ] Incident + backend
- [ ] Full end-to-end test

## Phase 7 — Competition
- [ ] Reliable demo
- [ ] Physical model
- [ ] Presentation
- [ ] Promotional video
- [ ] Final documentation

---

# 41. Master Project Description

> **Innov-IoT is a smart rental motorcycle incident detection and emergency assistance system that combines ESP32 control, MPU6050 motion sensing, NEO-6M GPS positioning, an ESP32-CAM front camera and an MD0147 GSM module. The system monitors the motorcycle, detects possible incidents, obtains the location, captures visual evidence, gives the rider a 15-second opportunity to confirm safety or request assistance, and communicates emergency information through GSM and the application/backend to support faster response.**

---

# 42. Master Rule for Future Development

Whenever a hardware/software decision changes, update all related documents:

```text
Component list
      +
GPIO table
      +
Power table
      +
Wiring diagram
      +
Firmware
      +
Backend/API
      +
Testing plan
      +
Competition documentation
```

No old GPIO or power connection should remain in documentation after the final hardware is changed.

---

# 43. Current Status

| Area | Status |
|---|---|
| Project idea | Defined |
| Main components | Mostly defined |
| MD0147 GSM | Confirmed |
| Battery | Confirmed |
| Power architecture | Defined |
| Main GPIO plan | Mostly defined |
| Incident workflow | Defined |
| 15-second confirmation | Defined |
| SAFE/HELP | Defined |
| GSM/SMS concept | Defined |
| App concept | Defined |
| Owner dashboard | Defined |
| Database concept | Defined |
| Physical board | 14.5 × 6.3 cm planned |
| Final physical pin verification | Pending |
| Final component placement | Pending |
| GPS UART | Pending |
| Camera communication | Pending |
| Full firmware | Integration required |
| Backend | Implementation required |
| Application | Implementation required |
| Full-system test | Pending |

---

# 44. Reference to Physical Circuit Requirements

The supplied circuit-layout document states that the final hand-built layout must verify the dot-board specifications, exact ESP32 variant, MD0147 pin labels, buck converter, battery/switch, GPS, ESP32-CAM, MPU6050, buzzer, SAFE/HELP buttons, LEDs, resistors/capacitors, ignition input, physical placement constraints and final firmware GPIO conflicts before the final compact circuit can be created.

