# CHANGELOG

## v0.4.0
SQLite Viewer 0.4 is a complete rewrite of this extension with a focus on improved performance.

It also implements SQLite Viewer's **most requested feature**: Default file association for `.db` files! 

Additionally, version 0.4 ships many quality of life improvements:

- Double clicking a cell will now open the modal and pre-select the text content
- The extension will now attempt to auto-size text columns based on visible content on first open
- Blob columns containing known image formats are previewed inline
- Blob columns up to 256 bytes (that aren't images) are rendered in hex format instead of as a download button
- Pinning a row will no longer remove it from the main view
- Columns can now be hidden in the sidebar
- The `ROWID` column can now be displayed (enable in sidebar)
- It is now possible to select and rearrange multiple columns at the same time in the sidebar
- The modal/dialog view can now be resized
- Downloading a blob will now automatically add an appropriate file extension if it can be inferred
- Column sizes and pinned now persist when switching to another table (but not after closing the tab/file) 

### Performance
- Faster virtualized scrolling
- Faster columns resizing

### Style
- Many aspects of the extension's UI should match VSCode's style closer

## v0.4.3
### Fixes
- Added back search functionality for tables
- Fixed ROWID column sizing
- Fixed a browser history issue when using the extension on the web

## v0.4.2
### Fixes
- Fixed column widths resetting when refreshing a file
- Fixed column order resetting when refreshing a file
- Fixed an issue causing the grid to collapse when refreshing a file
- Fixed sidebar column order not updating when pinning a column
### Style
- Increased default column width by 20%

## v0.4.1
Added minimal application reporting

## v0.3.0 – v3.0.24
Minor bug fixes and previews 

## v0.2.4
- Added max file size setting

## v0.2.3
- Fixed opening FTS4 & FTS5 files
- Fixed showing large integers
- Fixed showing booleans
- Fixed opening files exported by pandas `.to_sql`

## v0.2.2
Prerelease version

## v0.2.1
Prerelease version

## v0.2.0
Prerelease version

## v0.1.5
* Fixed a bug that caused the SQLite WebWorker to be initialized twice
* Updated dependencies
  * Updated SQLite to 3.38.0

## v0.1.4
* Updated dependencies
  * Updated SQLite to 3.37.2
  * Updated React v18 to latest Release Candidate

## v0.1.3
* Added ref to external link

## v0.1.2
### Fixes
* Opening files with the R*Tree extension will no longer produce an error
* Binary values are now always rendered as download buttons, even when not specified as `BLOB` type

### Other
* Updated dependencies
  * Updated React to v18 Release Candidate

## v0.1.1
### Fixes
* Show error message when trying to open SQLite file using extensions

## v0.1.0
You can now open any file with SQLite Viewer and set SQLite Viewer as default for any file extension:

![Open With](documentation/new.gif)

### Changes
* Removed the `.db` file association, as it is too generic to be permanently associated with SQLite Viewer. 
You can easily restore the old behavior through VSCode's Open With menu.
* Updated dependencies
  * Updated React to v18 Beta
  * Updated React Router to v6

### Fixes
* Fixed a transparency issue with fixed columns with certain color themes

## v0.0.1 – v0.0.24
* Replaced Emojis with Codicons for better VSCode integration
* Added support for pinning columns and rows
* Added reload button 
* Column virtualization: Tables with many columns should no longer impact UI performance
* Added keyboard shortcuts
  - Ctrl+F/Cmd+F: Focus global search
  - Ctrl+R/Cmd+R: Reload content
