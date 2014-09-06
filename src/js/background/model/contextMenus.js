﻿//  A model which interfaces with the chrome.contextMenus API to generate context menus when clicking on YouTube pages or links.
define([
    'background/collection/streamItems',
    'background/collection/playlists',
    'background/model/chromeNotifications',
    'background/model/signInManager',
    'background/model/song',
    'background/model/tabManager',
    'common/enum/dataSourceType',
    'common/model/youTubeV3API',
    'common/model/utility',
    'common/model/dataSource'
], function (StreamItems, Playlists, ChromeNotifications, SignInManager, Song, TabManager, DataSourceType, YouTubeV3API, Utility, DataSource) {
    'use strict';

    var ContextMenu = Backbone.Model.extend({
        initialize: function () {
            var youTubeUrlPatterns = TabManager.get('youTubeUrlPatterns');
            
            //  Show the Streamus context menu items only when right-clicking on an appropriate target.
            this._createContextMenus(['link'], youTubeUrlPatterns, true);
            this._createContextMenus(['page'], youTubeUrlPatterns, false);
            
            chrome.contextMenus.create({
                'contexts': ['selection'],
                'title': chrome.i18n.getMessage('searchForAndPlay') + ' \'%s\'',
                'onclick': function (onClickData) {
                    this._getSongFromText(onClickData.selectionText, function (song) {
                        StreamItems.addSongs(song, {
                            playOnAdd: true
                        });
                    });
                }.bind(this)
            });
        },
        
        _createContextMenus: function (contexts, urlPattern, isTarget) {
            var contextMenuOptions = {
                'contexts': contexts,
                'targetUrlPatterns': isTarget ? urlPattern : undefined,
                'documentUrlPatterns': !isTarget ? urlPattern : undefined
            };

            //  Create menu items for specific actions:
            chrome.contextMenus.create(_.extend({}, contextMenuOptions, {
                'title': chrome.i18n.getMessage('play'),
                'onclick': function (onClickData) {
                    var url = onClickData.linkUrl || onClickData.pageUrl;

                    this._getSongFromUrl(url, function (song) {
                        StreamItems.addSongs(song, {
                            playOnAdd: true
                        });
                    });
                }.bind(this)
            }));

            chrome.contextMenus.create(_.extend({}, contextMenuOptions, {
                'title': chrome.i18n.getMessage('add'),
                'onclick': function (onClickData) {
                    var url = onClickData.linkUrl || onClickData.pageUrl;
                    
                    this._getSongFromUrl(url, function (song) {
                        StreamItems.addSongs(song);
                    });
                }.bind(this)
            }));
            
            if (SignInManager.get('signedIn')) {
                this._createSaveContextMenu(contextMenuOptions);
            } else {
                this.listenTo(SignInManager, 'change:signedIn', function (model, signedIn) {
                    if (signedIn) {
                        this._createSaveContextMenu(contextMenuOptions);
                    }
                });
            }
        },
        
        _createSaveContextMenu: function(contextMenuOptions) {
            //  Create a sub menu item to hold all Playlists
            var playlistsContextMenuId = chrome.contextMenus.create(_.extend({}, contextMenuOptions, {
                'title': chrome.i18n.getMessage('save')
            }));

            //  Create menu items for each playlist
            Playlists.each(function (playlist) {
                this._createPlaylistContextMenu(contextMenuOptions, playlistsContextMenuId, playlist);
            }.bind(this));
            
            this.listenTo(Playlists, 'add', function (addedPlaylist) {
                this._createPlaylistContextMenu(contextMenuOptions, playlistsContextMenuId, addedPlaylist);
            });
        },
        
        //  Whenever a playlist context menu is clicked -- add the related song to that playlist.
        _createPlaylistContextMenu: function (contextMenuOptions, playlistsContextMenuId, playlist) {
            var playlistContextMenuId = chrome.contextMenus.create(_.extend({}, contextMenuOptions, {
                'title': playlist.get('title'),
                'parentId': playlistsContextMenuId,
                'onclick': function (onClickData) {
                    var url = onClickData.linkUrl || onClickData.pageUrl;

                    this._getSongFromUrl(url, function (song) {
                        playlist.get('items').addSongs(song);
                    });
                }.bind(this)
            }));

            //  Update context menu items whenever the playlist's data changes (renamed or deleted)
            this.listenTo(playlist, 'change:title', function () {
                chrome.contextMenus.update(playlistContextMenuId, {
                    'title': playlist.get('title')
                });
            });

            this.listenTo(playlist, 'destroy', function () {
                chrome.contextMenus.remove(playlistContextMenuId);
            });
        },
        
        _getSongFromText: function (text, callback) {
            YouTubeV3API.getSongInformationByTitle({
                title: text,
                success: function(songInformation) {
                    callback(new Song(songInformation));
                }
            });
        },
        
        _getSongFromUrl: function(url, callback) {
            var dataSource = new DataSource({ url: url });

            dataSource.parseUrl({
                success: function() {
                    YouTubeV3API.getSongInformation({
                        songId: dataSource.get('id'),
                        success: function (songInformation) {
                            callback(new Song(songInformation));
                        },
                        error: function () {
                            //  TODO: Maybe I want to only use ChromeNotifications if the UI isn't open?
                            //  TODO: i18n
                            ChromeNotifications.create({
                                title: 'Failed to find song',
                                message: 'An issue was encountered while attempting to find song with URL: ' + url
                            });
                        }
                    });
                }
            });
        },
    });

    return new ContextMenu();
});