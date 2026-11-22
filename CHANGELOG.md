# WiseTV for Windows: changes

The section for each version becomes the text of its GitHub release, which the app shows when it offers the update.

## 1.1.10
- Fixed: on Windows, clicks and mouse movement over the picture never reached WiseTV at all (your log showed none arriving). An invisible layer over the picture now catches them, so clicking the picture shows the controls again (click again to hide them), moving the mouse brings them up, and the guide preview's buttons appear when you point at it

## 1.1.9
- Fixed: after 1.1.8 the live TV controls wouldn't come back. Clicking the picture shows them again (click again to hide them), and moving the mouse across the picture brings them up too
- WiseTV now notes mouse clicks over the video in its log file, to help track down any remaining mouse problems

## 1.1.8
- Fixed (second try): the live TV controls now go away 8 seconds after you click the picture. Moving the mouse no longer brings them up; it only shows the pointer
- Click the picture again to hide the controls straight away
- Using a button on the control row, or moving the mouse over it, keeps the controls up for another 8 seconds

## 1.1.7
- New free playlist: Free-TV (worldwide), about 2,200 free-to-air channels grouped by country (Settings → Playlists → + Free channels)
- Playlists that list both a combined TV guide and its per-country parts now download only the combined one, so the guide loads much faster

## 1.1.6
- Fixed: the controls you get by clicking the picture (and the guide preview's buttons) didn't go away on their own. Windows reports a "mouse moved" every time the controls appear or disappear, even when the mouse is still, and WiseTV took that as you moving it. Now only real mouse movement keeps them up

## 1.1.5
- Fixed: with a big playlist (hundreds of channel groups) the TV Guide's playlist and group list squashed its rows so the names couldn't be read
- A "Find a group" box appears at the top of that list when there are lots of groups; just start typing, press Enter to pick the first match
- The list is a little wider, and pointing at a long group name shows it in full

## 1.1.4
- Click the picture while watching live TV to get a row of controls: pause/play, channel up and down, last channel, volume, record, channel list, back to the TV Guide, options (audio, subtitles, picture size) and full screen on/off
- The controls stay up while the channel is paused or while the pointer is over them

## 1.1.3
- Point at the TV guide's preview to get a full-screen button, a mute button and a volume slider
- Fixed: the mouse didn't work over the video (moving it now brings back the player controls; clicking, double-clicking, right-clicking and the scroll wheel work too)
- The pointer hides by itself after a few seconds of full-screen video

## 1.1.2
- Fixed: black picture with working sound on Windows (newer Chromium hid the video player's window)
- Settings: "Open WiseTV's data folder" to find the log files

## 1.1.1
- Fixed: video could be black on Windows while the sound played
- Volume slider and mute button at the top of the video screen (the mouse wheel and + / − keys still work too)

## 1.1.0
- WiseTV now checks for updates when it starts (and every few hours) and can update itself
- Free channels: 13 free playlists (Samsung TV Plus, XUMO, Roku Channel, Local Now and more) on the Add playlist screen
- Switch between playlists from the TV guide's group menu

## 1.0.1
- Free channel playlists

## 1.0.0
- First Windows version: TV guide with live preview, full-screen player, recordings with series rules, movies and series, Plex, search
